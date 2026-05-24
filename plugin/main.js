const { Plugin, Notice, PluginSettingTab, Setting } = require('obsidian');
const tls = require('tls');
const path = require('path');
const { TextDecoder } = require('util');

const DEFAULT_SETTINGS = {
  outputFolder: '个人笔记/邮件入库/待整理',
  standardRootFolder: '个人笔记/邮件入库',
  autoCreateStandardFolders: true,
  locale: 'en',
  filenameTemplate: '{subject} {date}',
  defaultCategory: '待整理',
  summaryLength: 500,
  autoSyncEnabled: false,
  autoSyncIntervalMinutes: 10,
  filterEnabled: false,
  whitelistEmails: '',
  blacklistEmails: '',
  subjectKeywords: '',
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
      syncRead: false,
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
      syncRead: false,
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
    this.settings.locale = normalizeLocale(this.settings.locale);
    this.settings.autoSyncEnabled = !!this.settings.autoSyncEnabled;
    this.settings.autoSyncIntervalMinutes = normalizeAutoSyncInterval(this.settings.autoSyncIntervalMinutes);
    this.settings.filterEnabled = !!this.settings.filterEnabled;
    this.settings.whitelistEmails = this.settings.whitelistEmails || '';
    this.settings.blacklistEmails = this.settings.blacklistEmails || '';
    this.settings.subjectKeywords = this.settings.subjectKeywords || '';
  }

  async saveSettings() {
    this.settings.locale = normalizeLocale(this.settings.locale);
    await this.saveData(this.settings);
  }

  showImportedMailToast(importedNotes) {
    const t = getI18n(this.settings.locale);
    const container = document.createElement('div');
    container.className = 'email-importer-mail-toast';

    const title = document.createElement('div');
    title.className = 'email-importer-mail-toast-title';
    title.textContent = t.newMailToastTitle(importedNotes.length);
    container.appendChild(title);

    const list = document.createElement('div');
    list.className = 'email-importer-mail-toast-list';
    for (const note of importedNotes.slice(0, 5)) {
      const item = document.createElement('button');
      item.className = 'email-importer-mail-toast-item';
      item.type = 'button';
      item.innerHTML = `<div class=\"email-importer-mail-toast-subject\">${escapeHtml(note.subject)}</div><div class=\"email-importer-mail-toast-meta\"><span class=\"email-importer-mail-toast-from\">${escapeHtml(note.from)}</span><span class=\"email-importer-mail-toast-sep\">·</span><span class=\"email-importer-mail-toast-account\">${escapeHtml(note.account)}</span></div>`;
      item.addEventListener('click', async () => {
        const file = this.app.vault.getAbstractFileByPath(note.path);
        if (file) await this.app.workspace.getLeaf(true).openFile(file);
        container.remove();
      });
      list.appendChild(item);
    }
    container.appendChild(list);

    const close = document.createElement('button');
    close.className = 'email-importer-mail-toast-close';
    close.type = 'button';
    close.textContent = t.closeLabel;
    close.addEventListener('click', () => container.remove());
    container.appendChild(close);

    document.body.appendChild(container);
    window.setTimeout(() => container.remove(), 20000);
  }

  showImportedMailSystemNotifications(importedNotes) {
    if (typeof Notification === 'undefined') return;
    const t = getI18n(this.settings.locale);
    const notes = importedNotes.slice(0, 3);

    const sendNotifications = () => {
      for (const note of notes) {
        const notification = new Notification(t.systemNotificationTitle, {
          body: `${note.subject}\n${note.from}`,
          silent: false
        });
        notification.onclick = async () => {
          try {
            window.focus();
          } catch (_) {}
          const file = this.app.vault.getAbstractFileByPath(note.path);
          if (file) await this.app.workspace.getLeaf(true).openFile(file);
          notification.close();
        };
        window.setTimeout(() => notification.close(), 20000);
      }
    };

    if (Notification.permission === 'granted') {
      sendNotifications();
      return;
    }

    if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((permission) => {
        if (permission === 'granted') sendNotifications();
      }).catch(() => {});
    }
  }

  async ensureStandardStructureIfNeeded() {
    if (!this.settings.autoCreateStandardFolders) return;
    await createStandardFolders(this.app, normalizeFolder(this.settings.standardRootFolder || DEFAULT_SETTINGS.standardRootFolder));
  }

  setupAutoSync() {
    if (!this.settings.autoSyncEnabled) return;
    const minutes = normalizeAutoSyncInterval(this.settings.autoSyncIntervalMinutes);
    const timer = setInterval(() => {
      this.syncAllAccounts({ silent: true, automatic: true });
    }, minutes * 60 * 1000);

    if (typeof this.registerInterval === 'function') {
      this.registerInterval(timer);
    }
  }

  setRibbonState(state, enabled = true) {
    if (!this.ribbonIconEl) return;
    this.ribbonIconEl.toggleClass(state, enabled);
  }

  clearRibbonState(state) {
    this.setRibbonState(state, false);
  }

  async syncAllAccounts(options = {}) {
    const t = getI18n(this.settings.locale);
    if (this.isSyncing) {
      if (!options.silent) new Notice(t.busy);
      return 0;
    }

    const enabledAccounts = this.settings.accounts.filter((account) => account.enabled);
    if (!enabledAccounts.length) {
      if (!options.silent) new Notice(t.noAccounts);
      return 0;
    }

    this.isSyncing = true;
    this.setRibbonState('is-syncing', true);
    this.clearRibbonState('has-error');
    if (!options.silent) new Notice(t.syncStart(enabledAccounts.length));
    let imported = 0;
    let skipped = 0;
    let failed = false;
    const importedNotes = [];

    for (const account of enabledAccounts) {
      try {
        const result = await this.syncAccount(account);
        imported += result.imported;
        skipped += result.skipped;
        if (result.importedNotes?.length) importedNotes.push(...result.importedNotes);
      } catch (error) {
        failed = true;
        console.error('Email Importer sync failed', account.name, error);
        if (!options.silent) new Notice(t.accountFailed(account.name, error.message));
      }
    }

    await this.saveSettings();
    this.isSyncing = false;
    this.setRibbonState('is-syncing', false);
    this.setRibbonState('has-error', failed);
    if (imported > 0) this.setRibbonState('has-new-mail', true);
    if (!options.silent) new Notice(t.syncDone(imported, skipped));
    if (options.silent && imported > 0) new Notice(t.autoSyncDone(imported, skipped));
    if (importedNotes.length) {
      this.showImportedMailToast(importedNotes);
      this.showImportedMailSystemNotifications(importedNotes);
    }
    return imported;
  }

  async testAccountConnection(account) {
    validateAccount(account);
    const client = new ImapClient(account);
    try {
      await client.testConnection();
      new Notice(getI18n(this.settings.locale).connectionOk(account.name));
      return true;
    } catch (error) {
      console.error('Email Importer connection test failed', account.name, error);
      new Notice(getI18n(this.settings.locale).connectionFail(account.name, error.message));
      return false;
    } finally {
      await client.close();
    }
  }

  async syncAccount(account) {
    validateAccount(account);
    const client = new ImapClient(account);
    let imported = 0;
    let skipped = 0;
    const importedNotes = [];
    try {
      await client.connect();
      const unreadSeqs = await client.search('UNSEEN');
      const readSeqs = account.syncRead ? await client.search('SEEN') : [];
      const maxEmails = Number(account.maxEmails || 10);
      const processSeqs = async (seqs, readState) => {
        let importedForState = 0;
        for (const seq of [...seqs].reverse()) {
          if (importedForState >= maxEmails) break;
          const fetched = await client.fetchFull(seq);
          const email = parseFetchResponse(fetched.lines);
          const messageIdKey = email.messageId || `${account.id}:${readState}:${seq}:${email.subject}`;
          if (this.settings.importedMessageIds[messageIdKey]) continue;
          const filterResult = shouldSkipEmail(email, this.settings);
          if (filterResult.skip) {
            skipped += 1;
            this.settings.importedMessageIds[messageIdKey] = {
              importedAt: new Date().toISOString(),
              account: account.name,
              subject: email.subject || '',
              skipped: true,
              reason: filterResult.reason
            };
            continue;
          }
          const notePath = await this.writeEmailNote(account, email, readState);
          this.settings.importedMessageIds[messageIdKey] = {
            importedAt: new Date().toISOString(),
            account: account.name,
            subject: email.subject || '',
            readState
          };
          imported += 1;
          importedForState += 1;
          importedNotes.push({
            path: notePath,
            account: account.name,
            subject: email.subject || 'No Subject',
            from: email.from || '',
            date: email.date || ''
          });
          if (account.markSeen) {
            await client.addFlags(seq, ['\\Seen']);
          }
        }
      };

      await processSeqs(unreadSeqs, 'unread');
      if (account.syncRead) {
        await processSeqs(readSeqs, 'read');
      }
    } finally {
      await client.close();
    }
    return { imported, skipped, importedNotes };
  }

  async writeEmailNote(account, email, readState = 'unread') {
    const baseFolder = resolveAccountOutputFolder(account, this.settings, readState);
    const folder = resolveSenderOutputFolder(baseFolder, email.from || '');
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
    const attachmentLinks = await this.saveEmailAttachments(folder, subject, email.attachments || []);
    const externalAttachmentLinks = email.externalAttachments || [];
    const content = buildNoteContent({
      account,
      email,
      date,
      bodyText,
      attachmentLinks,
      externalAttachmentLinks,
      category: this.settings.defaultCategory || '待整理'
    });
    await this.app.vault.create(filePath, content);
    return filePath;
  }

  async saveEmailAttachments(folder, subject, attachments) {
    if (!attachments.length) return [];
    const attachmentFolder = path.posix.join(folder, 'Attachments', sanitizeFileName(subject || 'No Subject'));
    await ensureFolder(this.app, attachmentFolder);
    const links = [];
    for (const attachment of attachments) {
      const safeName = sanitizeFileName(attachment.filename || '附件');
      const filePath = uniquePath(this.app, path.posix.join(attachmentFolder, safeName));
      await this.app.vault.createBinary(filePath, attachment.content);
      links.push({
        name: safeName,
        path: filePath,
        contentType: attachment.contentType || ''
      });
    }
    return links;
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
    const t = getI18n(this.plugin.settings.locale);
    containerEl.createEl('h2', { text: t.title });

    new Setting(containerEl)
      .setName(t.languageName)
      .setDesc(t.languageDesc)
      .addDropdown((dropdown) => dropdown
        .addOption('zh', t.zhOption)
        .addOption('en', t.enOption)
        .setValue(normalizeLocale(this.plugin.settings.locale))
        .onChange(async (value) => {
          this.plugin.settings.locale = normalizeLocale(value);
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName(t.syncNowName)
      .setDesc(t.syncNowDesc)
      .addButton((button) => button
        .setButtonText(t.syncButton)
        .setCta()
        .onClick(async () => {
          await this.plugin.syncAllAccounts();
        }));

    new Setting(containerEl)
      .setName(t.autoSyncName)
      .setDesc(t.autoSyncDesc)
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.settings.autoSyncEnabled)
        .onChange(async (value) => {
          this.plugin.settings.autoSyncEnabled = value;
          await this.plugin.saveSettings();
          new Notice(t.autoSyncSavedNotice);
        }));

    new Setting(containerEl)
      .setName(t.autoSyncIntervalName)
      .setDesc(t.autoSyncIntervalDesc)
      .addText((text) => text
        .setPlaceholder('10')
        .setValue(String(this.plugin.settings.autoSyncIntervalMinutes || 10))
        .onChange(async (value) => {
          this.plugin.settings.autoSyncIntervalMinutes = normalizeAutoSyncInterval(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t.outputFolderName)
      .setDesc(t.outputFolderDesc)
      .addText((text) => text
        .setPlaceholder('个人笔记/邮件入库/待整理')
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t.standardRootName)
      .setDesc(t.standardRootDesc)
      .addText((text) => text
        .setPlaceholder('个人笔记/邮件入库')
        .setValue(this.plugin.settings.standardRootFolder || DEFAULT_SETTINGS.standardRootFolder)
        .onChange(async (value) => {
          this.plugin.settings.standardRootFolder = value.trim() || DEFAULT_SETTINGS.standardRootFolder;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t.autoCreateFoldersName)
      .setDesc(t.autoCreateFoldersDesc)
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.settings.autoCreateStandardFolders)
        .onChange(async (value) => {
          this.plugin.settings.autoCreateStandardFolders = value;
          await this.plugin.saveSettings();
          if (value) {
            await this.plugin.ensureStandardStructureIfNeeded();
            new Notice(this.t().standardFoldersReadyNotice);
          }
        }));

    new Setting(containerEl)
      .setName(t.createFoldersNowName)
      .setDesc(t.createFoldersNowDesc)
      .addButton((button) => button
        .setButtonText(t.createFoldersButton)
        .onClick(async () => {
          await this.plugin.ensureStandardStructureIfNeeded();
          new Notice(t.createFoldersNotice);
        }));

    new Setting(containerEl)
      .setName(t.defaultCategoryName)
      .setDesc(t.defaultCategoryDesc)
      .addText((text) => text
        .setPlaceholder('待整理')
        .setValue(this.plugin.settings.defaultCategory)
        .onChange(async (value) => {
          this.plugin.settings.defaultCategory = value.trim() || '待整理';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t.summaryLengthName)
      .setDesc(t.summaryLengthDesc)
      .addText((text) => text
        .setPlaceholder('500')
        .setValue(String(this.plugin.settings.summaryLength || 500))
        .onChange(async (value) => {
          const parsed = Number(value);
          this.plugin.settings.summaryLength = Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: t.filterSectionTitle });
    containerEl.createEl('p', { text: t.filterPriorityDesc });

    new Setting(containerEl)
      .setName(t.filterEnabledName)
      .setDesc(t.filterEnabledDesc)
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.settings.filterEnabled)
        .onChange(async (value) => {
          this.plugin.settings.filterEnabled = value;
          await this.plugin.saveSettings();
        }));

    addTextAreaSetting(
      this.plugin,
      containerEl,
      t.whitelistName,
      t.whitelistDesc,
      this.plugin.settings.whitelistEmails || '',
      async (value) => this.plugin.settings.whitelistEmails = value
    );

    addTextAreaSetting(
      this.plugin,
      containerEl,
      t.blacklistName,
      t.blacklistDesc,
      this.plugin.settings.blacklistEmails || '',
      async (value) => this.plugin.settings.blacklistEmails = value
    );

    addTextAreaSetting(
      this.plugin,
      containerEl,
      t.subjectKeywordsName,
      t.subjectKeywordsDesc,
      this.plugin.settings.subjectKeywords || '',
      async (value) => this.plugin.settings.subjectKeywords = value
    );

    containerEl.createEl('h3', { text: t.accountsTitle });
    containerEl.createEl('p', { text: t.accountsDesc });

    this.plugin.settings.accounts.forEach((account, index) => {
      const section = containerEl.createDiv({ cls: 'email-importer-account' });
      section.createEl('h4', { text: account.name || `${t.accountLabel} ${index + 1}` });

      new Setting(section)
        .setName(t.accountEnabledName)
        .setDesc(t.accountEnabledDesc)
        .addToggle((toggle) => toggle
          .setValue(!!account.enabled)
          .onChange(async (value) => {
            account.enabled = value;
            await this.plugin.saveSettings();
          }));

      addTextSetting(this.plugin, section, t.accountDisplayName, t.accountDisplayNameDesc, account.name, async (value) => account.name = value || account.name);
      addTextSetting(this.plugin, section, t.imapHostName, t.imapHostDesc, account.host, async (value) => account.host = value || account.host);
      addTextSetting(this.plugin, section, t.portName, t.portDesc, String(account.port || 993), async (value) => account.port = Number(value) || 993);
      addTextSetting(this.plugin, section, t.usernameName, t.usernameDesc, account.username, async (value) => account.username = value.trim());
      addTextSetting(this.plugin, section, t.passwordName, t.passwordDesc, account.password, async (value) => account.password = normalizeAccountPassword(value), true);
      addTextSetting(this.plugin, section, t.folderName, t.folderDesc, account.folder || 'INBOX', async (value) => account.folder = value.trim() || 'INBOX');
      addTextSetting(this.plugin, section, t.accountOutputName, t.accountOutputDesc, account.outputFolder || '', async (value) => account.outputFolder = value.trim());
      addTextSetting(this.plugin, section, t.maxEmailsName, t.maxEmailsDesc, String(account.maxEmails || 10), async (value) => account.maxEmails = Number(value) || 10);

      new Setting(section)
        .setName(t.syncReadName)
        .setDesc(t.syncReadDesc)
        .addToggle((toggle) => toggle
          .setValue(!!account.syncRead)
          .onChange(async (value) => {
            account.syncRead = value;
            await this.plugin.saveSettings();
          }));

      new Setting(section)
        .setName(t.markSeenName)
        .setDesc(t.markSeenDesc)
        .addToggle((toggle) => toggle
          .setValue(!!account.markSeen)
          .onChange(async (value) => {
            account.markSeen = value;
            await this.plugin.saveSettings();
          }));

      new Setting(section)
        .setName(t.testConnectionName)
        .setDesc(t.testConnectionDesc)
        .addButton((button) => button
          .setClass('email-importer-test-button')
          .setButtonText(t.testConnectionButton(account.name || `${t.accountLabel} ${index + 1}`))
          .onClick(async () => {
            button.setDisabled(true);
            button.buttonEl.classList.remove('is-success', 'is-error');
            button.buttonEl.classList.add('is-testing');
            button.setButtonText(t.testing);
            try {
              const ok = await this.plugin.testAccountConnection(account);
              button.buttonEl.classList.remove('is-testing');
              button.buttonEl.classList.add(ok ? 'is-success' : 'is-error');
              button.setButtonText(ok ? t.testSuccess : t.testFailed);
            } finally {
              button.setDisabled(false);
            }
          }));
    });

    new Setting(containerEl)
      .setName(t.syncNowBottomName)
      .setDesc(t.syncNowBottomDesc)
      .addButton((button) => button
        .setButtonText(t.syncButton)
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

function addTextAreaSetting(plugin, container, name, desc, value, apply) {
  new Setting(container)
    .setName(name)
    .setDesc(desc)
    .addTextArea((text) => {
      text.setPlaceholder(desc).setValue(value || '');
      text.inputEl.rows = 5;
      text.inputEl.cols = 40;
      text.onChange(async (next) => {
        await apply(next);
        await plugin.saveSettings();
      });
    });
}

function normalizeLocale(locale) {
  return String(locale || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

function getI18n(locale) {
  const en = normalizeLocale(locale) === 'en';
  return en ? I18N.en : I18N.zh;
}

const I18N = {
  zh: {
    title: 'Email Importer 设置',
    languageName: '界面语言',
    languageDesc: '切换设置页显示语言',
    zhOption: '中文',
    enOption: 'English',
    syncNowName: '📥 立即同步邮件',
    syncNowDesc: '最常用入口：点击后立即同步所有已启用邮箱',
    syncButton: '开始同步',
    autoSyncName: '自动同步',
    autoSyncDesc: '开启后按固定间隔自动检查新邮件；仍会使用 Message-ID 去重，避免重复导入',
    autoSyncSavedNotice: 'Email Importer: 自动同步设置已保存，重启或重载插件后生效',
    standardFoldersReadyNotice: 'Email Importer: 已检查并创建标准目录结构',
    autoSyncIntervalName: '自动同步间隔（分钟）',
    autoSyncIntervalDesc: '例如 1、10、30。建议 10 分钟以上；设置过短可能导致邮箱服务限制',
    outputFolderName: '输出目录',
    outputFolderDesc: '全局默认输出目录；如果某个邮箱配置了自己的输出目录，会优先使用该邮箱目录',
    standardRootName: '标准根目录',
    standardRootDesc: '自动创建标准邮件目录结构时使用的根目录',
    autoCreateFoldersName: '自动创建标准目录结构',
    autoCreateFoldersDesc: '插件加载时自动创建：待整理 / 账单凭证 / 项目沟通 / 账号通知 / 精华摘要（邮件读写状态目录固定英文）',
    createFoldersNowName: '立即创建标准目录',
    createFoldersNowDesc: '手动执行一次标准目录结构创建',
    createFoldersButton: '创建目录',
    createFoldersNotice: 'Email Importer: 标准目录结构已创建/已存在',
    defaultCategoryName: '默认分类',
    defaultCategoryDesc: '写入 frontmatter 的默认 category',
    summaryLengthName: '摘要长度',
    summaryLengthDesc: '正文摘要最长保留多少字符',
    filterSectionTitle: '邮件过滤',
    filterPriorityDesc: '优先级：白名单邮箱 > 黑名单邮箱 > 主题关键词。白名单/黑名单只匹配发件人邮箱地址，关键词只匹配主题。',
    filterEnabledName: '启用邮件过滤',
    filterEnabledDesc: '开启后按下面规则跳过不需要入库的邮件；不会删除邮箱原邮件',
    whitelistName: '白名单邮箱地址',
    whitelistDesc: '一行一个。命中后直接导入，例如 noreply@github.com 或 @notify.cloudflare.com',
    blacklistName: '黑名单邮箱地址',
    blacklistDesc: '一行一个。命中后跳过导入，例如 @temu.com 或 ads@example.com',
    subjectKeywordsName: '主题关键词',
    subjectKeywordsDesc: '一行一个。只匹配邮件主题，例如 优惠 / 促销 / Hot deals',
    accountsTitle: '邮箱账号',
    accountsDesc: 'Gmail 请使用 App Password；QQ 邮箱请开启 IMAP 并使用授权码。',
    accountLabel: '账号',
    accountEnabledName: '启用',
    accountEnabledDesc: '启用后会参与同步',
    accountDisplayName: '显示名称',
    accountDisplayNameDesc: '例如 Gmail',
    imapHostName: 'IMAP 主机',
    imapHostDesc: 'imap.gmail.com / imap.qq.com',
    portName: '端口',
    portDesc: '993',
    usernameName: '用户名',
    usernameDesc: '邮箱地址',
    passwordName: '密码 / 授权码',
    passwordDesc: 'Gmail App Password / QQ 授权码',
    folderName: '文件夹',
    folderDesc: 'INBOX',
    accountOutputName: '邮箱专属输出目录',
    accountOutputDesc: '可留空。读写状态子目录固定为英文：Read Mail / Unread Mail / Attachments',
    maxEmailsName: '每次最多导入',
    maxEmailsDesc: '10',
    syncReadName: '同步已读邮件',
    syncReadDesc: '默认关闭，只同步未读邮件。开启后会额外同步已读邮件，并分别写入“Read Mail / Unread Mail”子文件夹',
    markSeenName: '同步后标记为已读',
    markSeenDesc: '关闭时使用 BODY.PEEK，不会改动已读状态',
    testConnectionName: '测试连接',
    testConnectionDesc: '验证当前邮箱配置能否成功连接 IMAP',
    testConnectionButton: (name) => `测试 ${name}`,
    testing: '测试中...',
    testSuccess: '测试成功',
    testFailed: '测试失败',
    newMailToastTitle: (count) => `收到 ${count} 封新邮件，点击可打开`,
    systemNotificationTitle: '有新邮件',
    closeLabel: '关闭',
    syncNowBottomName: '立即同步',
    syncNowBottomDesc: '备用入口：和顶部“立即同步邮件”按钮功能相同',
    busy: 'Email Importer: 正在同步中，请稍候',
    noAccounts: 'Email Importer: 请先在设置中启用至少一个邮箱账号',
    syncStart: (count) => `Email Importer: 开始同步 ${count} 个邮箱...`,
    accountFailed: (name, error) => `同步 ${name} 失败：${error}`,
    syncDone: (imported, skipped) => `Email Importer: 同步完成，导入 ${imported} 封，过滤 ${skipped} 封`,
    autoSyncDone: (imported, skipped) => `Email Importer: 自动同步导入 ${imported} 封新邮件，过滤 ${skipped} 封`,
    connectionOk: (name) => `Email Importer: ${name} 连接成功`,
    connectionFail: (name, error) => `Email Importer: ${name} 连接失败：${error}`,
  },
  en: {
    title: 'Email Importer Settings',
    languageName: 'Interface Language',
    languageDesc: 'Change the settings page language',
    zhOption: '中文',
    enOption: 'English',
    syncNowName: '📥 Sync Now',
    syncNowDesc: 'Main entry: sync all enabled mailboxes now',
    syncButton: 'Start Sync',
    autoSyncName: 'Auto Sync',
    autoSyncDesc: 'Poll new mail on a fixed interval; Message-ID dedupe still prevents duplicates',
    autoSyncSavedNotice: 'Email Importer: auto-sync saved; reload the plugin or restart Obsidian to apply',
    standardFoldersReadyNotice: 'Email Importer: standard folders checked/created',
    autoSyncIntervalName: 'Auto Sync Interval (minutes)',
    autoSyncIntervalDesc: 'Examples: 1, 10, 30. 10+ minutes recommended; too short may hit mailbox limits',
    outputFolderName: 'Output Folder',
    outputFolderDesc: 'Global default output folder; per-account output folder takes priority if set',
    standardRootName: 'Standard Root Folder',
    standardRootDesc: 'Root folder used for auto-created email folders',
    autoCreateFoldersName: 'Auto-create Standard Folders',
    autoCreateFoldersDesc: 'Create: To Sort / Bills / Project / Account / Highlights on load (mail state folders stay in English)',
    createFoldersNowName: 'Create Standard Folders Now',
    createFoldersNowDesc: 'Run standard folder creation once manually',
    createFoldersButton: 'Create Folders',
    createFoldersNotice: 'Email Importer: standard folders created or already exist',
    defaultCategoryName: 'Default Category',
    defaultCategoryDesc: 'Default frontmatter category',
    summaryLengthName: 'Summary Length',
    summaryLengthDesc: 'Max characters kept in the summary',
    filterSectionTitle: 'Mail Filters',
    filterPriorityDesc: 'Priority: whitelist email > blacklist email > subject keywords. Whitelist/blacklist match sender email only; keywords match subject only.',
    filterEnabledName: 'Enable Mail Filters',
    filterEnabledDesc: 'Skip unwanted messages using the rules below; original mail is not deleted',
    whitelistName: 'Whitelist Emails',
    whitelistDesc: 'One per line. Matched senders are always imported, e.g. noreply@github.com or @notify.cloudflare.com',
    blacklistName: 'Blacklist Emails',
    blacklistDesc: 'One per line. Matched senders are skipped, e.g. @temu.com or ads@example.com',
    subjectKeywordsName: 'Subject Keywords',
    subjectKeywordsDesc: 'One per line. Match subject only, e.g. deal / promo / Hot deals',
    accountsTitle: 'Mail Accounts',
    accountsDesc: 'Use App Password for Gmail; enable IMAP and use the authorization code for QQ Mail.',
    accountLabel: 'Account',
    accountEnabledName: 'Enabled',
    accountEnabledDesc: 'Include this account in sync',
    accountDisplayName: 'Display Name',
    accountDisplayNameDesc: 'e.g. Gmail',
    imapHostName: 'IMAP Host',
    imapHostDesc: 'imap.gmail.com / imap.qq.com',
    portName: 'Port',
    portDesc: '993',
    usernameName: 'Username',
    usernameDesc: 'Email address',
    passwordName: 'Password / Code',
    passwordDesc: 'Gmail App Password / QQ authorization code',
    folderName: 'Folder',
    folderDesc: 'INBOX',
    accountOutputName: 'Account Output Folder',
    accountOutputDesc: 'Optional. Read/write state folders are fixed in English: Read Mail / Unread Mail / Attachments',
    maxEmailsName: 'Max Emails Per Sync',
    maxEmailsDesc: '10',
    syncReadName: 'Sync Read Mail',
    syncReadDesc: 'Off by default. When enabled, read mail is also synced into separate Read Mail / Unread Mail folders',
    markSeenName: 'Mark as Read After Sync',
    markSeenDesc: 'When off, uses BODY.PEEK and does not change read status',
    testConnectionName: 'Test Connection',
    testConnectionDesc: 'Verify the current IMAP settings',
    testConnectionButton: (name) => `Test ${name}`,
    testing: 'Testing...',
    testSuccess: 'Success',
    testFailed: 'Failed',
    newMailToastTitle: (count) => `${count} new mail(s) received — click to open`,
    systemNotificationTitle: 'New Mail',
    closeLabel: 'Close',
    syncNowBottomName: 'Sync Now',
    syncNowBottomDesc: 'Backup entry: same as the top Sync Now button',
    busy: 'Email Importer: syncing now, please wait',
    noAccounts: 'Email Importer: enable at least one mailbox in settings first',
    syncStart: (count) => `Email Importer: starting sync for ${count} mailbox(es)...`,
    accountFailed: (name, error) => `Sync failed for ${name}: ${error}`,
    syncDone: (imported, skipped) => `Email Importer: sync done, imported ${imported}, skipped ${skipped}`,
    autoSyncDone: (imported, skipped) => `Email Importer: auto-sync imported ${imported} new mail(s), skipped ${skipped}`,
    connectionOk: (name) => `Email Importer: ${name} connected successfully`,
    connectionFail: (name, error) => `Email Importer: ${name} connection failed: ${error}`,
  }
};

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
  account.password = normalizeAccountPassword(account.password);
}

function normalizeAccountPassword(password) {
  return String(password || '').replace(/\s+/g, '');
}

function shouldSkipEmail(email, settings) {
  if (!settings.filterEnabled) return { skip: false, reason: '' };

  const fromEmail = extractEmailAddress(email.from || '').toLowerCase();
  const subject = String(email.subject || '').toLowerCase();
  const whitelist = parseRuleLines(settings.whitelistEmails).map((item) => item.toLowerCase());
  const blacklist = parseRuleLines(settings.blacklistEmails).map((item) => item.toLowerCase());
  const keywords = parseRuleLines(settings.subjectKeywords).map((item) => item.toLowerCase());

  const whiteRule = whitelist.find((rule) => emailRuleMatches(fromEmail, rule));
  if (whiteRule) return { skip: false, reason: `whitelist:${whiteRule}` };

  const blackRule = blacklist.find((rule) => emailRuleMatches(fromEmail, rule));
  if (blackRule) return { skip: true, reason: `blacklist:${blackRule}` };

  const keyword = keywords.find((rule) => subject.includes(rule));
  if (keyword) return { skip: true, reason: `subject:${keyword}` };

  return { skip: false, reason: '' };
}

function parseRuleLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractEmailAddress(from) {
  const angleMatch = String(from || '').match(/<([^>]+)>/);
  if (angleMatch) return angleMatch[1].trim();
  const emailMatch = String(from || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return (emailMatch?.[0] || String(from || '')).trim();
}

function extractSenderName(from) {
  const value = decodeMimeWords(String(from || '')).trim();
  const angleIndex = value.indexOf('<');
  if (angleIndex > 0) {
    return value.slice(0, angleIndex).replace(/^["']|["']$/g, '').trim();
  }
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '').replace(/[<>()"']/g, '').trim();
}

function emailRuleMatches(email, rule) {
  if (!email || !rule) return false;
  if (rule.startsWith('@')) return email.endsWith(rule);
  return email === rule;
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
  const attachments = extractAttachments(rawEmail);
  const externalAttachments = extractExternalAttachmentLinks(bodyText);
  return {
    subject: decodedSubject || '无主题邮件',
    from: decodedFrom || '',
    date: date || '',
    messageId: (messageId || '').trim(),
    bodyText,
    attachments,
    externalAttachments
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

function extractAttachments(rawEmail) {
  const attachments = [];
  collectAttachments(rawEmail, attachments);
  return attachments;
}

function extractExternalAttachmentLinks(text) {
  const value = String(text || '');
  const links = [];
  const urlRegex = /https?:\/\/mail\.qq\.com\/cgi-bin\/ftnExs_download\?[^\s<>"']+/gi;
  const urls = [...value.matchAll(urlRegex)].map((match) => match[0].replace(/[),，。；;]+$/g, ''));
  for (const url of urls) {
    links.push({
      name: extractNearbyAttachmentName(value, url) || 'QQ超大附件',
      url
    });
  }
  return links;
}

function extractNearbyAttachmentName(text, url) {
  const before = String(text || '').slice(Math.max(0, String(text || '').indexOf(url) - 160), String(text || '').indexOf(url));
  const fileMatch = before.match(/([^\s\n\r<>:"|?*]+?\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|jpg|jpeg|png|gif|bmp|webp))/i);
  return fileMatch?.[1] || '';
}

function collectAttachments(entityText, attachments, depth = 0) {
  if (depth > 8) return;
  const normalized = String(entityText || '').replace(/\r/g, '');
  const { headers, body } = splitHeadersAndBody(normalized);
  const rawContentType = getHeaderValue(headers, 'Content-Type');
  const rawContentDisposition = getHeaderValue(headers, 'Content-Disposition');
  const contentType = rawContentType.toLowerCase();
  const contentDisposition = rawContentDisposition.toLowerCase();
  const fallbackBoundary = extractBoundaryFromText(body);

  if (contentType.includes('multipart/') || fallbackBoundary) {
    const boundary = extractBoundary(rawContentType) || fallbackBoundary;
    if (!boundary) return;
    const parts = splitMimeParts(body, boundary);
    for (const part of parts) {
      collectAttachments(part, attachments, depth + 1);
    }
    return;
  }

  if (!isAttachmentPart(contentType, contentDisposition)) return;
  const filename = extractAttachmentFilename(headers, rawContentType, rawContentDisposition);
  const transferEncoding = getHeaderValue(headers, 'Content-Transfer-Encoding').toLowerCase();
  const content = decodeTransferEncodingToBuffer(body, transferEncoding);
  if (!content.length) return;
  attachments.push({
    filename: normalizeAttachmentFilename(filename, contentType, content, attachments.length + 1),
    contentType: contentType.split(';')[0].trim(),
    content
  });
}

function parseMimeEntity(entityText, depth = 0) {
  if (depth > 8) return '';
  const normalized = String(entityText || '').replace(/\r/g, '');
  const { headers, body } = splitHeadersAndBody(normalized);
  const rawContentType = getHeaderValue(headers, 'Content-Type');
  const rawContentDisposition = getHeaderValue(headers, 'Content-Disposition');
  const contentType = rawContentType.toLowerCase();
  const contentDisposition = rawContentDisposition.toLowerCase();
  const fallbackBoundary = extractBoundaryFromText(body);

  if (isAttachmentPart(contentType, contentDisposition)) {
    return '';
  }

  if (contentType.includes('multipart/') || fallbackBoundary) {
    const boundary = extractBoundary(rawContentType) || fallbackBoundary;
    if (boundary) {
      const parts = splitMimeParts(body, boundary);
      const plainParts = [];
      const htmlParts = [];

      for (const part of parts) {
        const partHeaders = splitHeadersAndBody(part).headers;
        const rawPartType = getHeaderValue(partHeaders, 'Content-Type');
        const rawPartDisposition = getHeaderValue(partHeaders, 'Content-Disposition');
        const partType = rawPartType.toLowerCase();
        const partDisposition = rawPartDisposition.toLowerCase();
        if (isAttachmentPart(partType, partDisposition)) continue;
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
        const rawPartType = getHeaderValue(partHeaders, 'Content-Type');
        const rawPartDisposition = getHeaderValue(partHeaders, 'Content-Disposition');
        const partType = rawPartType.toLowerCase();
        const partDisposition = rawPartDisposition.toLowerCase();
        if (isAttachmentPart(partType, partDisposition)) continue;
        if (partType.includes('text/html')) {
          const text = parseMimeEntity(part, depth + 1);
          if (isMeaningfulMailText(text)) htmlParts.push(text);
        }
      }

      if (htmlParts.length) {
        return cleanupText(htmlParts.join('\n\n'));
      }

      for (const part of parts) {
        const partHeaders = splitHeadersAndBody(part).headers;
        const rawPartType = getHeaderValue(partHeaders, 'Content-Type');
        const rawPartDisposition = getHeaderValue(partHeaders, 'Content-Disposition');
        const partType = rawPartType.toLowerCase();
        const partDisposition = rawPartDisposition.toLowerCase();
        if (isAttachmentPart(partType, partDisposition)) continue;
        const text = parseMimeEntity(part, depth + 1);
        if (isMeaningfulMailText(text)) return cleanupText(text);
      }
    }
  }

  return decodeLeafBody(headers, body, contentType);
}

function isAttachmentPart(contentType, contentDisposition) {
  const type = String(contentType || '').toLowerCase();
  const disposition = String(contentDisposition || '').toLowerCase();
  if (disposition.includes('attachment')) return true;
  if (disposition.includes('filename=')) return true;
  if (type.includes('name=')) return true;
  if (type.includes('application/pdf')) return true;
  if (!type) return false;
  return !type.includes('text/plain') && !type.includes('text/html') && !type.includes('multipart/');
}

function looksLikeBase64Pdf(text) {
  const compact = String(text || '').replace(/\s+/g, '');
  return compact.startsWith('JVBERi0') || compact.startsWith('JVBER');
}

function normalizeAttachmentFilename(filename, contentType, content, index) {
  const name = sanitizeFileName(filename || '');
  const detectedExt = detectAttachmentExt(contentType, content);
  if (!name) return defaultAttachmentName(contentType, content, index);
  const currentExt = path.posix.extname(name);
  if (!currentExt && detectedExt) return `${name}${detectedExt}`;
  if (currentExt.toLowerCase() === '.bin' && detectedExt) return `${name.slice(0, -4)}${detectedExt}`;
  return name;
}

function detectAttachmentExt(contentType, content) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('pdf') || bufferStartsWith(content, '%PDF')) return '.pdf';
  if (type.includes('png') || bufferStartsWithBytes(content, [0x89, 0x50, 0x4e, 0x47])) return '.png';
  if (type.includes('jpeg') || type.includes('jpg') || bufferStartsWithBytes(content, [0xff, 0xd8, 0xff])) return '.jpg';
  if (type.includes('gif') || bufferStartsWith(content, 'GIF8')) return '.gif';
  if (type.includes('bmp') || bufferStartsWith(content, 'BM')) return '.bmp';
  if (type.includes('webp') || bufferStartsWith(content, 'RIFF')) return '.webp';
  return '';
}

function bufferStartsWith(buffer, text) {
  if (!buffer || buffer.length < text.length) return false;
  return buffer.subarray(0, text.length).toString('latin1') === text;
}

function bufferStartsWithBytes(buffer, bytes) {
  if (!buffer || buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function extractAttachmentFilename(headers, contentType, contentDisposition) {
  const raw = [
    extractHeaderParam(contentDisposition, 'filename'),
    extractHeaderParam(contentDisposition, 'filename*'),
    extractHeaderParam(contentType, 'name'),
    extractHeaderParam(contentType, 'name*')
  ].find(Boolean);
  return sanitizeFileName(decodeMimeWords(decodeRfc2231Value(raw || '')) || '');
}

function extractHeaderParam(headerValue, paramName) {
  const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = new RegExp(`${escaped}\\s*=\\s*"([^"]+)"`, 'i').exec(String(headerValue || ''));
  if (quoted) return quoted[1];
  const unquoted = new RegExp(`${escaped}\\s*=\\s*([^;\\s]+)`, 'i').exec(String(headerValue || ''));
  return unquoted?.[1] || '';
}

function decodeRfc2231Value(value) {
  const text = String(value || '').trim();
  const match = text.match(/^([^']*)''(.+)$/);
  const encoded = match ? match[2] : text;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function defaultAttachmentName(contentType, content, index) {
  const ext = detectAttachmentExt(contentType, content);
  if (ext) return `附件${index}${ext}`;
  return `附件${index}.bin`;
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
  const fallbackDecoded = shouldTryChineseCharset(decoded, charset) ? decodeBufferWithCharset(buffer, 'gb18030') : decoded;
  const cleaned = contentType.includes('text/html') ? htmlToText(fallbackDecoded) : fallbackDecoded;
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
  if (!looksLikeQuotedPrintableText(value)) return value;
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

function looksLikeQuotedPrintableText(value) {
  const text = String(value || '');
  if (/=\r?\n/.test(text)) return true;
  const matches = text.match(/=([A-Fa-f0-9]{2})/g) || [];
  if (matches.length < 3) return false;
  return /=(?:[ECF][0-9A-Fa-f]|3D)/.test(text);
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

function shouldTryChineseCharset(decoded, charset) {
  const normalized = normalizeCharset(charset);
  if (!['utf-8', 'us-ascii'].includes(normalized)) return false;
  const value = String(decoded || '');
  if (!value) return false;
  const badChars = (value.match(/�/g) || []).length;
  return badChars >= 2 || /�QQ|��|�e/.test(value);
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
  if (looksLikeBase64Pdf(value)) return false;
  if (/^%PDF-\d+\.\d+/.test(value)) return false;
  return true;
}

function cleanupText(text) {
  return stripMimeResidue(decodeHtmlEntities(decodeLooseQuotedPrintableText(String(text || ''))))
    .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
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
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing) continue;

    try {
      await app.vault.createFolder(current);
    } catch (error) {
      const existsAfterRace = app.vault.getAbstractFileByPath(current);
      const alreadyExists = /already exists/i.test(String(error?.message || error));
      if (!existsAfterRace && !alreadyExists) throw error;
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

function resolveAccountOutputFolder(account, settings, readState = '') {
  const stateFolder = readState === 'read' ? 'Read Mail' : 'Unread Mail';
  if (account.outputFolder && account.outputFolder.trim()) {
    return `${normalizeFolder(account.outputFolder)}/${stateFolder}`;
  }

  const root = normalizeFolder(settings.standardRootFolder || DEFAULT_SETTINGS.standardRootFolder);
  const username = String(account.username || account.name || account.id || '').trim();
  const accountShort = shortAccountName(username);
  const host = String(account.host || '').toLowerCase();

  if (account.id === 'qq' || host.includes('qq.com') || username.endsWith('@qq.com')) {
    return `${root}/${sanitizeFileName(accountShort || 'QQ')}QQ邮箱/${stateFolder}`;
  }

  if (account.id === 'gmail' || host.includes('gmail.com') || username.endsWith('@gmail.com')) {
    return `${root}/${sanitizeFileName(accountShort || 'Gmail')}Gmail/${stateFolder}`;
  }

  return `${root}/${sanitizeFileName(accountShort || account.name || '邮箱')}/${stateFolder}`;
}

function resolveSenderOutputFolder(baseFolder, from) {
  const senderEmail = extractEmailAddress(from).toLowerCase();
  const senderName = extractSenderName(from);
  const senderFolderName = buildSenderFolderName(senderName, senderEmail);
  return `${baseFolder}/${senderFolderName}`;
}

function buildSenderFolderName(senderName, senderEmail) {
  const name = sanitizeFileName(sanitizeTitle(senderName || '未知发件人'));
  const email = sanitizeFileName(String(senderEmail || '未知邮箱').toLowerCase());
  if (!name || name === email) return email;
  return `${name} ${email}`.slice(0, 160);
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

function buildNoteContent({ account, email, date, bodyText, attachmentLinks, externalAttachmentLinks, category }) {
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
    '## 附件',
    ...renderAttachmentList(attachmentLinks, externalAttachmentLinks),
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAttachmentList(attachmentLinks, externalAttachmentLinks) {
  const lines = [];
  if (attachmentLinks && attachmentLinks.length) {
    lines.push(...attachmentLinks.map((attachment) => renderAttachmentMarkdown(attachment)));
  }
  if (externalAttachmentLinks && externalAttachmentLinks.length) {
    lines.push(...externalAttachmentLinks.map((attachment) => `- [${attachment.name || '外部附件'}](${attachment.url})`));
  }
  return lines.length ? lines : ['- 无'];
}

function renderAttachmentMarkdown(attachment) {
  if (isImageAttachment(attachment)) {
    return `- ![[${attachment.path}]]`;
  }
  return `- [[${attachment.path}|${attachment.name}]]`;
}

function isImageAttachment(attachment) {
  const type = String(attachment?.contentType || '').toLowerCase();
  const ext = path.posix.extname(String(attachment?.path || attachment?.name || '')).toLowerCase();
  return type.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
}
