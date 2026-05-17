const { Plugin, Notice, PluginSettingTab, Setting } = require('obsidian');
const tls = require('tls');
const path = require('path');

const DEFAULT_SETTINGS = {
  outputFolder: '个人笔记/邮件入库/待整理',
  standardRootFolder: '个人笔记/邮件入库',
  autoCreateStandardFolders: true,
  filenameTemplate: '{date} {account} {subject}',
  defaultCategory: '待整理',
  summaryLength: 500,
  accounts: [
    {
      id: 'gmail',
      name: 'Gmail',
      enabled: false,
      host: 'imap.gmail.com',
      port: 993,
      username: '',
      password: '',
      folder: 'INBOX',
      outputFolder: '个人笔记/邮件入库/Gmail',
      search: 'UNSEEN',
      maxEmails: 10,
      markSeen: false
    },
    {
      id: 'qq',
      name: 'QQ邮箱',
      enabled: false,
      host: 'imap.qq.com',
      port: 993,
      username: '',
      password: '',
      folder: 'INBOX',
      outputFolder: '个人笔记/邮件入库/QQ邮箱',
      search: 'UNSEEN',
      maxEmails: 10,
      markSeen: false
    }
  ],
  importedMessageIds: {}
};

class ImapClient {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.buffer = '';
    this.tagCounter = 0;
    this.pending = null;
  }

  async connect() {
    this.socket = tls.connect({
      host: this.config.host,
      port: Number(this.config.port || 993),
      servername: this.config.host,
      rejectUnauthorized: true
    });

    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => {
      this.buffer += chunk;
      this._flush();
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.socket.once('error', onError);
      this.socket.once('secureConnect', () => {
        this.socket.off('error', onError);
        resolve();
      });
    });

    await this._waitForGreeting();
    await this.exec(`LOGIN ${quoteString(this.config.username)} ${quoteString(this.config.password)}`);
    await this.exec(`SELECT ${quoteString(this.config.folder || 'INBOX')}`);
  }

  async testConnection() {
    await this.connect();
    return true;
  }

  async close() {
    if (!this.socket) return;
    try {
      await this.exec('LOGOUT');
    } catch (_) {}
    this.socket.end();
    this.socket.destroy();
    this.socket = null;
  }

  async search(criteria) {
    const response = await this.exec(`SEARCH ${criteria || 'UNSEEN'}`);
    const line = response.lines.find((entry) => entry.startsWith('* SEARCH')) || '* SEARCH';
    return line.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean);
  }

  async fetchFull(seq) {
    const tag = this._nextTag();
    const command = `${tag} FETCH ${seq} (BODY.PEEK[])\r\n`;
    return await this._collectFetch(tag, command);
  }

  async addFlags(seq, flags) {
    await this.exec(`STORE ${seq} +FLAGS.SILENT (${flags.join(' ')})`);
  }

  async exec(command) {
    if (!this.socket) throw new Error('IMAP socket not connected');
    const tag = this._nextTag();
    const payload = `${tag} ${command}\r\n`;
    return await new Promise((resolve, reject) => {
      this.pending = { tag, resolve, reject, lines: [] };
      this.socket.write(payload, 'utf8');
    });
  }

  _nextTag() {
    this.tagCounter += 1;
    return `A${String(this.tagCounter).padStart(4, '0')}`;
  }

  async _waitForGreeting() {
    const timeout = Date.now() + 10000;
    while (!this.buffer.includes('\r\n')) {
      if (Date.now() > timeout) throw new Error('IMAP greeting timeout');
      await sleep(50);
    }
    const line = this._shiftLine();
    if (!line.startsWith('* OK')) {
      throw new Error(`IMAP greeting failed: ${line}`);
    }
  }

  _shiftLine() {
    const idx = this.buffer.indexOf('\r\n');
    if (idx === -1) return null;
    const line = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 2);
    return line;
  }

  _flush() {
    if (!this.pending) return;
    let line;
    while ((line = this._shiftLine()) !== null) {
      this.pending.lines.push(line);
      if (line.startsWith(this.pending.tag + ' ')) {
        const pending = this.pending;
        this.pending = null;
        if (line.includes(' OK')) {
          pending.resolve({ lines: pending.lines });
        } else {
          pending.reject(new Error(line));
        }
        break;
      }
    }
  }

  async _collectFetch(tag, command) {
    if (!this.socket) throw new Error('IMAP socket not connected');
    return await new Promise((resolve, reject) => {
      const lines = [];
      this.pending = { tag, resolve: (result) => resolve({ lines, raw: lines.join('\n'), result }), reject, lines };
      this.socket.write(command, 'utf8');
    });
  }
}

module.exports = class EmailImporterPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'sync-email-to-vault',
      name: '同步 Gmail / QQ 邮件到知识库',
      callback: async () => {
        await this.syncAllAccounts();
      }
    });

    this.addSettingTab(new EmailImporterSettingTab(this.app, this));

    try {
      await this.ensureStandardStructureIfNeeded();
    } catch (error) {
      console.error('Email Importer init failed', error);
      new Notice(`Email Importer 初始化异常：${error.message}`);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.accounts = mergeAccounts(this.settings.accounts || []);
    this.settings.importedMessageIds = this.settings.importedMessageIds || {};
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async ensureStandardStructureIfNeeded() {
    if (!this.settings.autoCreateStandardFolders) return;
    await createStandardFolders(this.app, normalizeFolder(this.settings.standardRootFolder || DEFAULT_SETTINGS.standardRootFolder));
  }

  async syncAllAccounts() {
    const enabledAccounts = this.settings.accounts.filter((account) => account.enabled);
    if (!enabledAccounts.length) {
      new Notice('Email Importer: 请先在设置中启用至少一个邮箱账号');
      return;
    }

    new Notice(`Email Importer: 开始同步 ${enabledAccounts.length} 个邮箱...`);
    let imported = 0;

    for (const account of enabledAccounts) {
      try {
        imported += await this.syncAccount(account);
      } catch (error) {
        console.error('Email Importer sync failed', account.name, error);
        new Notice(`同步 ${account.name} 失败：${error.message}`);
      }
    }

    await this.saveSettings();
    new Notice(`Email Importer: 同步完成，共导入 ${imported} 封邮件`);
  }

  async testAccountConnection(account) {
    validateAccount(account);
    const client = new ImapClient(account);
    try {
      await client.testConnection();
      new Notice(`Email Importer: ${account.name} 连接成功`);
      return true;
    } catch (error) {
      console.error('Email Importer connection test failed', account.name, error);
      new Notice(`Email Importer: ${account.name} 连接失败：${error.message}`);
      return false;
    } finally {
      await client.close();
    }
  }

  async syncAccount(account) {
    validateAccount(account);
    const client = new ImapClient(account);
    let imported = 0;
    try {
      await client.connect();
      const seqs = await client.search(account.search || 'UNSEEN');
      const limitedSeqs = seqs.slice(-Number(account.maxEmails || 10));
      for (const seq of limitedSeqs) {
        const fetched = await client.fetchFull(seq);
        const email = parseFetchResponse(fetched.lines);
        const messageIdKey = email.messageId || `${account.id}:${seq}:${email.subject}`;
        if (this.settings.importedMessageIds[messageIdKey]) continue;
        await this.writeEmailNote(account, email);
        this.settings.importedMessageIds[messageIdKey] = {
          importedAt: new Date().toISOString(),
          account: account.name,
          subject: email.subject || ''
        };
        imported += 1;
        if (account.markSeen) {
          await client.addFlags(seq, ['\\Seen']);
        }
      }
    } finally {
      await client.close();
    }
    return imported;
  }

  async writeEmailNote(account, email) {
    const folder = normalizeFolder(account.outputFolder || this.settings.outputFolder);
    await ensureFolder(this.app, folder);

    const date = normalizeDate(email.date);
    const subject = sanitizeTitle(email.subject || '无主题邮件');
    const fileName = sanitizeFileName(renderFilename(this.settings.filenameTemplate, {
      date,
      account: account.name,
      subject
    })) + '.md';
    const filePath = uniquePath(this.app, path.posix.join(folder, fileName));
    const bodyText = summarizeText(email.bodyText || '', this.settings.summaryLength);
    const content = buildNoteContent({
      account,
      email,
      date,
      bodyText,
      category: this.settings.defaultCategory || '待整理'
    });
    await this.app.vault.create(filePath, content);
  }
};

class EmailImporterSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Email Importer 设置' });

    new Setting(containerEl)
      .setName('输出目录')
      .setDesc('全局默认输出目录；如果某个邮箱配置了自己的输出目录，会优先使用该邮箱目录')
      .addText((text) => text
        .setPlaceholder('个人笔记/邮件入库/待整理')
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('标准根目录')
      .setDesc('自动创建标准邮件目录结构时使用的根目录')
      .addText((text) => text
        .setPlaceholder('个人笔记/邮件入库')
        .setValue(this.plugin.settings.standardRootFolder || DEFAULT_SETTINGS.standardRootFolder)
        .onChange(async (value) => {
          this.plugin.settings.standardRootFolder = value.trim() || DEFAULT_SETTINGS.standardRootFolder;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('自动创建标准目录结构')
      .setDesc('插件加载时自动创建：待整理 / 账单凭证 / 项目沟通 / 账号通知 / 精华摘要')
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.settings.autoCreateStandardFolders)
        .onChange(async (value) => {
          this.plugin.settings.autoCreateStandardFolders = value;
          await this.plugin.saveSettings();
          if (value) {
            await this.plugin.ensureStandardStructureIfNeeded();
            new Notice('Email Importer: 已检查并创建标准目录结构');
          }
        }));

    new Setting(containerEl)
      .setName('立即创建标准目录')
      .setDesc('手动执行一次标准目录结构创建')
      .addButton((button) => button
        .setButtonText('创建目录')
        .onClick(async () => {
          await this.plugin.ensureStandardStructureIfNeeded();
          new Notice('Email Importer: 标准目录结构已创建/已存在');
        }));

    new Setting(containerEl)
      .setName('默认分类')
      .setDesc('写入 frontmatter 的默认 category')
      .addText((text) => text
        .setPlaceholder('待整理')
        .setValue(this.plugin.settings.defaultCategory)
        .onChange(async (value) => {
          this.plugin.settings.defaultCategory = value.trim() || '待整理';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('摘要长度')
      .setDesc('正文摘要最长保留多少字符')
      .addText((text) => text
        .setPlaceholder('500')
        .setValue(String(this.plugin.settings.summaryLength || 500))
        .onChange(async (value) => {
          const parsed = Number(value);
          this.plugin.settings.summaryLength = Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: '邮箱账号' });
    containerEl.createEl('p', { text: 'Gmail 请使用 App Password；QQ 邮箱请开启 IMAP 并使用授权码。' });

    this.plugin.settings.accounts.forEach((account, index) => {
      const section = containerEl.createDiv({ cls: 'email-importer-account' });
      section.createEl('h4', { text: account.name || `账号 ${index + 1}` });

      new Setting(section)
        .setName('启用')
        .setDesc('启用后会参与同步')
        .addToggle((toggle) => toggle
          .setValue(!!account.enabled)
          .onChange(async (value) => {
            account.enabled = value;
            await this.plugin.saveSettings();
          }));

      addTextSetting(this.plugin, section, '显示名称', '例如 Gmail', account.name, async (value) => account.name = value || account.name);
      addTextSetting(this.plugin, section, 'IMAP 主机', 'imap.gmail.com / imap.qq.com', account.host, async (value) => account.host = value || account.host);
      addTextSetting(this.plugin, section, '端口', '993', String(account.port || 993), async (value) => account.port = Number(value) || 993);
      addTextSetting(this.plugin, section, '用户名', '邮箱地址', account.username, async (value) => account.username = value.trim());
      addTextSetting(this.plugin, section, '密码 / 授权码', 'Gmail App Password / QQ 授权码', account.password, async (value) => account.password = value, true);
      addTextSetting(this.plugin, section, '文件夹', 'INBOX', account.folder || 'INBOX', async (value) => account.folder = value.trim() || 'INBOX');
      addTextSetting(this.plugin, section, '邮箱专属输出目录', '例如 个人笔记/邮件入库/Gmail', account.outputFolder || '', async (value) => account.outputFolder = value.trim());
      addTextSetting(this.plugin, section, '搜索条件', '例如 UNSEEN / ALL', account.search || 'UNSEEN', async (value) => account.search = value.trim() || 'UNSEEN');
      addTextSetting(this.plugin, section, '每次最多导入', '10', String(account.maxEmails || 10), async (value) => account.maxEmails = Number(value) || 10);

      new Setting(section)
        .setName('同步后标记为已读')
        .setDesc('关闭时使用 BODY.PEEK，不会改动已读状态')
        .addToggle((toggle) => toggle
          .setValue(!!account.markSeen)
          .onChange(async (value) => {
            account.markSeen = value;
            await this.plugin.saveSettings();
          }));

      new Setting(section)
        .setName('测试连接')
        .setDesc('验证当前邮箱配置能否成功连接 IMAP')
        .addButton((button) => button
          .setButtonText(`测试 ${account.name || `账号 ${index + 1}`}`)
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('测试中...');
            try {
              await this.plugin.testAccountConnection(account);
            } finally {
              button.setDisabled(false);
              button.setButtonText(`测试 ${account.name || `账号 ${index + 1}`}`);
            }
          }));
    });

    new Setting(containerEl)
      .setName('立即同步')
      .setDesc('保存设置后手动执行一次同步')
      .addButton((button) => button
        .setButtonText('开始同步')
        .setCta()
        .onClick(async () => {
          await this.plugin.syncAllAccounts();
        }));
  }
}

function addTextSetting(plugin, container, name, desc, value, apply, isSecret = false) {
  new Setting(container)
    .setName(name)
    .setDesc(desc)
    .addText((text) => {
      text.setPlaceholder(desc).setValue(value || '');
      if (isSecret) text.inputEl.type = 'password';
      text.onChange(async (next) => {
        await apply(next);
        await plugin.saveSettings();
      });
    });
}

function mergeAccounts(accounts) {
  const byId = new Map((accounts || []).map((account) => [account.id, account]));
  return DEFAULT_SETTINGS.accounts.map((base) => Object.assign({}, base, byId.get(base.id) || {}));
}

function validateAccount(account) {
  for (const key of ['host', 'port', 'username', 'password']) {
    if (!account[key]) {
      throw new Error(`${account.name} 缺少 ${key} 配置`);
    }
  }
}

function quoteString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFetchResponse(lines) {
  const rawEmail = extractFirstFetchLiteral(lines) || lines.join('\n');
  const subject = matchHeader(rawEmail, 'Subject');
  const from = matchHeader(rawEmail, 'From');
  const date = matchHeader(rawEmail, 'Date');
  const messageId = matchHeader(rawEmail, 'Message-ID');
  const decodedSubject = decodeMimeWords(subject || '');
  const decodedFrom = decodeMimeWords(from || '');
  const bodyText = extractReadableText(rawEmail);
  return {
    subject: decodedSubject || '无主题邮件',
    from: decodedFrom || '',
    date: date || '',
    messageId: (messageId || '').trim(),
    bodyText
  };
}

function extractFirstFetchLiteral(lines) {
  const collected = [];
  let collecting = false;

  for (const line of lines) {
    if (!collecting) {
      if (/\{\d+\}$/.test(line)) {
        collecting = true;
      }
      continue;
    }

    if (line === ')' || /^\S+\s+OK\b/i.test(line)) {
      break;
    }

    collected.push(line);
  }

  return collected.join('\n').trim();
}

function matchHeader(text, header) {
  const regex = new RegExp(`^${header}:\\s*([\\s\\S]*?)(?=\\n[^\\s]|$)`, 'im');
  const match = text.match(regex);
  return match ? match[1].replace(/\n\s+/g, ' ').trim() : '';
}

function decodeMimeWords(input) {
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_, charset, encoding, data) => {
    try {
      let buffer;
      if (encoding.toUpperCase() === 'B') {
        buffer = Buffer.from(data, 'base64');
      } else {
        const qp = data.replace(/_/g, ' ').replace(/=([A-Fa-f0-9]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
        buffer = Buffer.from(qp, 'binary');
      }
      const normalized = String(charset).toLowerCase();
      if (normalized.includes('utf-8') || normalized.includes('us-ascii')) return buffer.toString('utf8');
      if (normalized.includes('gb') || normalized.includes('gbk') || normalized.includes('gb2312')) return buffer.toString('utf8');
      return buffer.toString('utf8');
    } catch (_) {
      return data;
    }
  });
}

function extractReadableText(rawBody) {
  const normalized = rawBody.replace(/\r/g, '');
  const contentType = /Content-Type:\s*([^;\n]+)/i.exec(normalized)?.[1]?.toLowerCase() || '';
  if (contentType.includes('multipart/')) {
    const boundary = /boundary="?([^"\n;]+)"?/i.exec(normalized)?.[1];
    if (boundary) {
      const parts = normalized.split(`--${boundary}`);
      for (const part of parts) {
        if (/Content-Type:\s*text\/plain/i.test(part)) {
          return decodePartBody(part);
        }
      }
      for (const part of parts) {
        if (/Content-Type:\s*text\/html/i.test(part)) {
          return htmlToText(decodePartBody(part));
        }
      }
    }
  }
  if (contentType.includes('text/html')) {
    return htmlToText(decodePartBody(normalized));
  }
  return decodePartBody(normalized);
}

function decodePartBody(part) {
  const splitIndex = part.indexOf('\n\n');
  const headerText = splitIndex >= 0 ? part.slice(0, splitIndex) : '';
  let body = splitIndex >= 0 ? part.slice(splitIndex + 2).trim() : part.trim();
  const transferEncoding = /Content-Transfer-Encoding:\s*([^\n]+)/i.exec(headerText)?.[1]?.trim().toLowerCase();

  if (transferEncoding === 'base64') {
    body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  } else if (transferEncoding === 'quoted-printable') {
    body = body
      .replace(/=\n/g, '')
      .replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  return body.replace(/\0/g, '').trim();
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function ensureFolder(app, folderPath) {
  if (!folderPath || folderPath === '.') return;
  const parts = folderPath.split('/');
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch (error) {
        if (!app.vault.getAbstractFileByPath(current)) {
          throw error;
        }
      }
    }
  }
}

async function createStandardFolders(app, rootFolder) {
  const root = normalizeFolder(rootFolder || DEFAULT_SETTINGS.standardRootFolder);
  const folders = [
    root,
    `${root}/待整理`,
    `${root}/账单凭证`,
    `${root}/项目沟通`,
    `${root}/账号通知`,
    `${root}/精华摘要`
  ];
  for (const folder of folders) {
    await ensureFolder(app, folder);
  }
}

function normalizeFolder(folder) {
  return String(folder || '').replace(/^\/+|\/+$/g, '') || DEFAULT_SETTINGS.outputFolder;
}

function normalizeDate(dateString) {
  const date = new Date(dateString || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function sanitizeTitle(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeFileName(value) {
  return value.replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
}

function renderFilename(template, vars) {
  return String(template || '{date} {subject}').replace(/\{(\w+)\}/g, (_, key) => vars[key] || '');
}

function uniquePath(app, filePath) {
  if (!app.vault.getAbstractFileByPath(filePath)) return filePath;
  const ext = path.posix.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  let index = 2;
  while (app.vault.getAbstractFileByPath(`${base} ${index}${ext}`)) {
    index += 1;
  }
  return `${base} ${index}${ext}`;
}

function summarizeText(text, maxLength) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? compact.slice(0, maxLength) + '…' : compact;
}

function buildNoteContent({ account, email, date, bodyText, category }) {
  const lines = [
    '---',
    'type: email-note',
    `source: ${yamlEscape(account.name)}`,
    `sender: ${yamlEscape(email.from || '')}`,
    `subject: ${yamlEscape(email.subject || '')}`,
    `date: ${date}`,
    `category: ${yamlEscape(category)}`,
    'status: imported',
    'tags:',
    '  - 邮件',
    '  - 自动导入',
    '---',
    '',
    `# ${email.subject || '无主题邮件'}`,
    '',
    '## 摘要',
    bodyText ? `- ${bodyText}` : '- ',
    '',
    '## 关键信息',
    `- 发件人：${email.from || ''}`,
    `- 日期：${email.date || date}`,
    `- 来源：${account.name}`,
    '',
    '## 待办',
    '- [ ] ',
    '',
    '## 原邮件信息',
    `- Message-ID：${email.messageId || ''}`,
    `- 文件夹：${account.folder || 'INBOX'}`,
    '',
    '## 原文摘录',
    bodyText || ''
  ];
  return lines.join('\n');
}

function yamlEscape(value) {
  return JSON.stringify(String(value || ''));
}
