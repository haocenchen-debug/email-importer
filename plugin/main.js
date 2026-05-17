const { Plugin, Notice, PluginSettingTab, Setting } = require('obsidian');
const tls = require('tls');
const path = require('path');
const { TextDecoder } = require('util');

const DEFAULT_SETTINGS = {
  outputFolder: '个人笔记/邮件入库/待整理',
  standardRootFolder: '个人笔记/邮件入库',
  autoCreateStandardFolders: true,
  filenameTemplate: '{subject} {date}',
  defaultCategory: '待整理',
  summaryLength: 500,
  autoSyncEnabled: false,
  autoSyncIntervalMinutes: 10,
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
      outputFolder: '',
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
      outputFolder: '',
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
    this.ribbonIconEl = null;
    this.isSyncing = false;

    this.addCommand({
      id: 'sync-email-to-vault',
      name: '同步 Gmail / QQ 邮件到知识库',
      callback: async () => {
        await this.syncAllAccounts();
      }
    });

    this.addCommand({
      id: 'sync-email-to-vault-editor-toolbar',
      name: '同步邮件到知识库',
      editorCallback: async () => {
        await this.syncAllAccounts();
      }
    });

    const ribbonIconEl = this.addRibbonIcon('mail-check', '同步 Gmail / QQ 邮件', async () => {
      this.clearRibbonState('has-new-mail');
      await this.syncAllAccounts();
    });
    this.ribbonIconEl = ribbonIconEl;
    ribbonIconEl.addClass('email-importer-sync-ribbon-icon');

    this.addSettingTab(new EmailImporterSettingTab(this.app, this));

    try {
      await this.ensureStandardStructureIfNeeded();
      this.setupAutoSync();
    } catch (error) {
      console.error('Email Importer init failed', error);
      new Notice(`Email Importer 初始化异常：${error.message}`);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.accounts = mergeAccounts(this.settings.accounts || []);
    this.settings.importedMessageIds = this.settings.importedMessageIds || {};
    this.settings.autoSyncEnabled = !!this.settings.autoSyncEnabled;
    this.settings.autoSyncIntervalMinutes = normalizeAutoSyncInterval(this.settings.autoSyncIntervalMinutes);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async ensureStandardStructureIfNeeded() {
    if (!this.settings.autoCreateStandardFolders) return;
    await createStandardFolders(this.app, normalizeFolder(this.settings.standardRootFolder || DEFAULT_SETTINGS.standardRootFolder));
  }

  setupAutoSync() {
    if (!this.settings.autoSyncEnabled) return;
    const minutes = normalizeAutoSyncInterval(this.settings.autoSyncIntervalMinutes);
    this.registerInterval(window.setInterval(() => {
      this.syncAllAccounts({ silent: true, automatic: true });
    }, minutes * 60 * 1000));
  }

  setRibbonState(state, enabled = true) {
    if (!this.ribbonIconEl) return;
    this.ribbonIconEl.toggleClass(state, enabled);
  }

  clearRibbonState(state) {
    this.setRibbonState(state, false);
  }

  async syncAllAccounts(options = {}) {
    if (this.isSyncing) {
      if (!options.silent) new Notice('Email Importer: 正在同步中，请稍候');
      return 0;
    }

    const enabledAccounts = this.settings.accounts.filter((account) => account.enabled);
    if (!enabledAccounts.length) {
      if (!options.silent) new Notice('Email Importer: 请先在设置中启用至少一个邮箱账号');
      return 0;
    }

    this.isSyncing = true;
    this.setRibbonState('is-syncing', true);
    this.clearRibbonState('has-error');
    if (!options.silent) new Notice(`Email Importer: 开始同步 ${enabledAccounts.length} 个邮箱...`);
    let imported = 0;
    let failed = false;

    for (const account of enabledAccounts) {
      try {
        imported += await this.syncAccount(account);
      } catch (error) {
        failed = true;
        console.error('Email Importer sync failed', account.name, error);
        if (!options.silent) new Notice(`同步 ${account.name} 失败：${error.message}`);
      }
    }

    await this.saveSettings();
    this.isSyncing = false;
    this.setRibbonState('is-syncing', false);
    this.setRibbonState('has-error', failed);
    if (imported > 0) this.setRibbonState('has-new-mail', true);
    if (!options.silent) new Notice(`Email Importer: 同步完成，共导入 ${imported} 封邮件`);
    if (options.silent && imported > 0) new Notice(`Email Importer: 自动同步导入 ${imported} 封新邮件`);
    return imported;
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
    const folder = resolveAccountOutputFolder(account, this.settings);
    await ensureFolder(this.app, folder);

    const date = normalizeDate(email.date);
    const subject = sanitizeTitle(email.subject || '无主题邮件');
    const fileName = sanitizeFileName(renderFilename(this.settings.filenameTemplate, {
      date,
      account: account.name,
      accountShort: shortAccountName(account.name),
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
      .setName('📥 立即同步邮件')
      .setDesc('最常用入口：点击后立即同步所有已启用邮箱')
      .addButton((button) => button
        .setButtonText('开始同步')
        .setCta()
        .onClick(async () => {
          await this.plugin.syncAllAccounts();
        }));

    new Setting(containerEl)
      .setName('自动同步')
      .setDesc('开启后按固定间隔自动检查新邮件；仍会使用 Message-ID 去重，避免重复导入')
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.settings.autoSyncEnabled)
        .onChange(async (value) => {
          this.plugin.settings.autoSyncEnabled = value;
          await this.plugin.saveSettings();
          new Notice('Email Importer: 自动同步设置已保存，重启或重载插件后生效');
        }));

    new Setting(containerEl)
      .setName('自动同步间隔（分钟）')
      .setDesc('例如 1、10、30。建议 10 分钟以上；设置过短可能导致邮箱服务限制')
      .addText((text) => text
        .setPlaceholder('10')
        .setValue(String(this.plugin.settings.autoSyncIntervalMinutes || 10))
        .onChange(async (value) => {
          this.plugin.settings.autoSyncIntervalMinutes = normalizeAutoSyncInterval(value);
          await this.plugin.saveSettings();
        }));

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
      addTextSetting(this.plugin, section, '邮箱专属输出目录', '可留空。留空时自动使用：QQ号QQ邮箱 / 用户名Gmail', account.outputFolder || '', async (value) => account.outputFolder = value.trim());
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
      .setDesc('备用入口：和顶部“立即同步邮件”按钮功能相同')
      .addButton((button) => button
        .setButtonText('开始同步')
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

function normalizeAutoSyncInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 10;
  return Math.max(1, Math.round(parsed));
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
      return decodeBufferWithCharset(buffer, charset);
    } catch (_) {
      return data;
    }
  });
}

function extractReadableText(rawBody) {
  return stripMimeResidue(parseMimeEntity(rawBody) || '');
}

function parseMimeEntity(entityText, depth = 0) {
  if (depth > 8) return '';
  const normalized = String(entityText || '').replace(/\r/g, '');
  const { headers, body } = splitHeadersAndBody(normalized);
  const contentType = getHeaderValue(headers, 'Content-Type').toLowerCase();
  const fallbackBoundary = extractBoundaryFromText(body);

  if (contentType.includes('multipart/') || fallbackBoundary) {
    const boundary = extractBoundary(contentType) || fallbackBoundary;
    if (boundary) {
      const parts = splitMimeParts(body, boundary);
      const plainParts = [];
      const htmlParts = [];

      for (const part of parts) {
        const partHeaders = splitHeadersAndBody(part).headers;
        const partType = getHeaderValue(partHeaders, 'Content-Type').toLowerCase();
        if (partType.includes('text/plain')) {
          const text = parseMimeEntity(part, depth + 1);
          if (isMeaningfulMailText(text)) plainParts.push(text);
        }
      }

      if (plainParts.length) {
        return cleanupText(plainParts.join('\n\n'));
      }

      for (const part of parts) {
        const partHeaders = splitHeadersAndBody(part).headers;
        const partType = getHeaderValue(partHeaders, 'Content-Type').toLowerCase();
        if (partType.includes('text/html')) {
          const text = parseMimeEntity(part, depth + 1);
          if (isMeaningfulMailText(text)) htmlParts.push(text);
        }
      }

      if (htmlParts.length) {
        return cleanupText(htmlParts.join('\n\n'));
      }

      for (const part of parts) {
        const text = parseMimeEntity(part, depth + 1);
        if (isMeaningfulMailText(text)) return cleanupText(text);
      }
    }
  }

  return decodeLeafBody(headers, body, contentType);
}

function splitHeadersAndBody(text) {
  const splitIndex = text.indexOf('\n\n');
  if (splitIndex === -1) {
    return { headers: '', body: text.trim() };
  }
  return {
    headers: text.slice(0, splitIndex),
    body: text.slice(splitIndex + 2)
  };
}

function getHeaderValue(headerText, headerName) {
  const regex = new RegExp(`^${headerName}:\\s*([\\s\\S]*?)(?=\\n[^\\s]|$)`, 'im');
  const match = String(headerText || '').match(regex);
  return decodeMimeWords((match?.[1] || '').replace(/\n[ \t]+/g, ' ').trim());
}

function extractBoundary(headerText) {
  return /boundary="?([^"\n;]+)"?/i.exec(String(headerText || ''))?.[1] || '';
}

function extractBoundaryFromText(text) {
  const match = String(text || '').match(/(?:^|\n)--([^\s\n]+)(?=\n|$)/);
  return match?.[1]?.replace(/--$/, '') || '';
}

function splitMimeParts(bodyText, boundary) {
  const marker = `--${boundary}`;
  return String(bodyText || '')
    .split(marker)
    .map((part) => part.replace(/^\n+|\n+$/g, ''))
    .filter((part) => part && part !== '--' && !part.startsWith('--'));
}

function decodeLeafBody(headerText, bodyText, contentType) {
  const charset = /charset="?([^"\n;]+)"?/i.exec(String(headerText || ''))?.[1] || 'utf-8';
  const transferEncoding = getHeaderValue(headerText, 'Content-Transfer-Encoding').toLowerCase();
  const buffer = decodeTransferEncodingToBuffer(bodyText, transferEncoding);
  const decoded = decodeBufferWithCharset(buffer, charset);
  const cleaned = contentType.includes('text/html') ? htmlToText(decoded) : decoded;
  return cleanupText(cleaned);
}

function decodeTransferEncodingToBuffer(bodyText, transferEncoding) {
  const body = String(bodyText || '');
  if (transferEncoding === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  }
  if (transferEncoding === 'quoted-printable') {
    const binary = body
      .replace(/=\r?\n/g, '')
      .replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(binary, 'binary');
  }
  return Buffer.from(body, 'utf8');
}

function decodeLooseQuotedPrintableText(text) {
  const value = String(text || '');
  if (!/=([A-Fa-f0-9]{2})/.test(value) && !/=3D/.test(value)) return value;
  try {
    return Buffer.from(
      value
        .replace(/=\r?\n/g, '')
        .replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
      'binary'
    ).toString('utf8');
  } catch (_) {
    return value;
  }
}

function decodeBufferWithCharset(buffer, charset) {
  try {
    const normalized = normalizeCharset(charset);
    if (normalized === 'utf-8' || normalized === 'us-ascii') return buffer.toString('utf8');
    if (normalized === 'latin1') return buffer.toString('latin1');
    return new TextDecoder(normalized, { fatal: false }).decode(buffer);
  } catch (_) {
    return buffer.toString('utf8');
  }
}

function normalizeCharset(charset) {
  const normalized = String(charset || 'utf-8').trim().toLowerCase();
  if (!normalized) return 'utf-8';
  if (normalized.includes('utf-8') || normalized.includes('utf8')) return 'utf-8';
  if (normalized.includes('us-ascii') || normalized === 'ascii') return 'us-ascii';
  if (normalized.includes('gb18030')) return 'gb18030';
  if (normalized.includes('gbk')) return 'gbk';
  if (normalized.includes('gb2312') || normalized.includes('gb_2312')) return 'gb18030';
  if (normalized.includes('big5')) return 'big5';
  if (normalized.includes('iso-8859-1') || normalized.includes('latin1')) return 'latin1';
  return normalized.replace(/["']/g, '');
}

function isMeaningfulMailText(text) {
  const value = cleanupText(text);
  if (!value) return false;
  if (/^This is a multi-part message in MIME format\.?$/i.test(value)) return false;
  return true;
}

function cleanupText(text) {
  return stripMimeResidue(decodeHtmlEntities(decodeLooseQuotedPrintableText(String(text || ''))))
    .replace(/\0/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function stripMimeResidue(text) {
  return String(text || '')
    .replace(/<!DOCTYPE[\s\S]*$/i, '')
    .replace(/<html[\s\S]*$/i, '')
    .replace(/(?:^|\n)--[^\s\n]+(?:--)?(?=\n|$)/g, '\n')
    .replace(/(?:^|\n)\s*(Content-Type|Content-Transfer-Encoding|Content-Disposition|Content-ID|Mime-Version):[^\n]*(?:\n[ \t]+[^\n]*)*/gi, '\n')
    .replace(/(?:^|\n)\s*charset="?[^"\n;]+"?/gi, '\n')
    .replace(/(?:^|\n)\s*boundary="?[^"\n;]+"?/gi, '\n')
    .replace(/(?:^|\n)\s*----==_mimepart_[^\s\n]+/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html || ''))
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
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

function resolveAccountOutputFolder(account, settings) {
  if (account.outputFolder && account.outputFolder.trim()) {
    return normalizeFolder(account.outputFolder);
  }

  const root = normalizeFolder(settings.standardRootFolder || DEFAULT_SETTINGS.standardRootFolder);
  const username = String(account.username || account.name || account.id || '').trim();
  const accountShort = shortAccountName(username);
  const host = String(account.host || '').toLowerCase();

  if (account.id === 'qq' || host.includes('qq.com') || username.endsWith('@qq.com')) {
    return `${root}/${sanitizeFileName(accountShort || 'QQ')}QQ邮箱`;
  }

  if (account.id === 'gmail' || host.includes('gmail.com') || username.endsWith('@gmail.com')) {
    return `${root}/${sanitizeFileName(accountShort || 'Gmail')}Gmail`;
  }

  return `${root}/${sanitizeFileName(accountShort || account.name || '邮箱')}`;
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

function shortAccountName(accountName) {
  return String(accountName || '').split('@')[0] || String(accountName || '');
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
