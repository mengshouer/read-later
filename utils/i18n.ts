/**
 * Runtime i18n.
 *
 * `browser.i18n` follows the *browser* UI language and cannot be switched at
 * runtime, so it can't satisfy a manual toggle. It is still the right tool for
 * the manifest's name/description (see `public/_locales/`), which genuinely
 * cannot be re-rendered. Everything the user sees inside the extension goes
 * through this layer instead.
 *
 * English is the source of truth: `MessageKey` is derived from the EN catalog,
 * so a missing Chinese translation is a type error rather than a runtime hole.
 */

export type Locale = 'en' | 'zh';
export type LocalePref = 'auto' | Locale;

const EN = {
  'app.loading': 'Loading…',
  'app.listTitle': 'Read Later — reading list',

  'nav.sidePanel': 'Side panel',
  'nav.sidePanelTip': 'Open in the side panel, which stays open while you read',
  'nav.fullPage': 'Full page',
  'nav.fullPageTip': 'Open the list in a full tab',
  'nav.settings': 'Settings',
  'nav.settingsTip': 'Settings',
  'nav.languageTip': 'Switch language',

  'err.storageTitle': 'Storage write failed',
  'err.quotaTitle': 'Storage is full',
  'err.quotaDetail': 'Export a backup, then delete some items — or unsubscribe from a rule list.',
  'err.exportBackup': 'Export backup',
  'err.dismiss': 'Dismiss',

  'search.placeholder': 'Search title or URL',

  'view.unread': 'Unread {n}',
  'view.archived': 'Archived {n}',
  'view.archivedTip': 'Opened during this browser session. Cleared when the browser closes.',

  'ctrl.fieldAdded': 'Added',
  'ctrl.fieldUpdated': 'Updated',
  'ctrl.fieldTipAdded': 'Sorting by when it was added',
  'ctrl.fieldTipUpdated': 'Sorting by when it was last updated',
  'ctrl.sortTipAsc': 'Oldest first',
  'ctrl.sortTipDesc': 'Newest first',
  'ctrl.groupOn': 'Grouped',
  'ctrl.groupOff': 'Flat',
  'ctrl.groupTip': 'Group by domain',
  'ctrl.actions': 'Actions',
  'ctrl.actionsTipOn': 'Hide the Copy and Delete buttons',
  'ctrl.actionsTipOff': 'Show Copy and Delete on each row',
  'ctrl.batch': 'Select',

  'batch.selectAll': 'Select all',
  'batch.clearSelection': 'Clear selection',
  'batch.selected': '{n} selected',
  'batch.delete': 'Delete',
  'batch.archive': 'Archive',
  'batch.restore': 'Restore',
  'batch.exit': 'Done',

  'row.copy': 'Copy',
  'row.restore': 'Restore',
  'row.delete': 'Delete',
  'row.untitled': '(untitled)',
  'row.progressTip': 'Reading position — the browser will try to return here',
  'row.progressNoAnchorTip': 'Imported percentage. There is no anchor text, so opening lands at the top.',
  'row.noProgressTip': 'No reading position saved',
  'row.addedAt': 'Added {date}',

  'empty.noMatch': 'Nothing matches that search.',
  'empty.archived': 'Nothing archived this session. The archive is cleared when the browser closes.',
  'empty.unread': 'Nothing saved yet. Right-click a page or a link and choose Read Later.',

  // Deliberately just the byte count: the view tabs sit directly above this line and
  // already carry both the unread and the archived count.
  'foot.usage': '{bytes} / {limit}',
  'foot.deleted': 'Deleted {n}',
  'foot.undoTip': 'Restores them, archive included. Available until the next delete.',

  'card.saveTitle': 'Save for later?',
  'card.updateTitle': 'Update this item?',
  'card.cancel': 'Cancel',
  'card.confirmSave': 'Save',
  'card.confirmUpdate': 'Update',
  'card.confirmSaveClose': 'Save and close',
  'card.confirmUpdateClose': 'Update and close',
  'card.untitled': '(untitled)',
  'card.restorable': 'Progress {percent} · browser can try to restore the position',
  'card.notRestorable': 'This page cannot save a reading position ({reason})',
  'card.hintUseLink': 'Tip: right-clicking a specific link saves that article directly',
  'card.existing': 'Already in the list',
  'card.existingWithProgress': 'Already in the list (was {percent})',
  'card.existingArchived': 'In the archive — will go back to unread',

  'toast.saved': 'Saved for later',
  'toast.updated': 'Already in the list — updated',
  'toast.undo': 'Undo',

  'reason.feedRole': 'the page declares role="feed"',
  'reason.noAnchor': 'no usable text at the top of the viewport',
  'reason.anchorNotUnique': 'the anchor text is not unique on the page',
  'reason.noFragmentSupport': 'this browser has no text-fragment support',

  'menu.savePage': 'Read Later (this page)',
  'menu.saveLink': 'Read Later (this link)',

  'opt.title': 'Read Later settings',
  'opt.lede': 'Everything is stored locally. Nothing is uploaded.',

  'opt.langSection': 'Language',
  'opt.langHint': 'The extension name shown by the browser always follows the browser language.',
  'opt.langAuto': 'Auto',
  'opt.langEn': 'English',
  'opt.langZh': '中文',

  'opt.storageSection': 'Storage',
  'opt.storageHint':
    'One 10 MB limit covers your items, your settings and the text of every subscribed list. A save that would exceed it fails, and says so.',
  'opt.statBytes': 'Used',
  'opt.statLimit': 'Limit',
  'opt.storageFreeHint':
    'To free space: export a backup under Data below, then delete items. Importing that file later brings them back.',
  'opt.statUnread': 'Unread',
  'opt.statArchived': 'Archived (this session)',
  'opt.statLists': 'Of that, rule lists',
  'opt.lastWriteError': 'Last write failed: {message}',

  'opt.filtersSection': 'Filter rules',
  'opt.filtersHint':
    'uBlock Origin / AdGuard syntax, limited to $removeparam. Nothing is active by default.',
  'opt.filtersDocsLabel': 'Syntax reference',
  'opt.filtersEmptyLede': 'No rules are active, so every query parameter is treated as part of a URL.',
  'opt.filtersMine': 'My rules',
  'opt.filterSave': 'Save',
  'opt.filterDiscard': 'Discard',
  'opt.filterSaved': 'Saved. Recompute keys below to apply them to existing items.',
  'opt.errLine': 'Line {line}: {message}',
  'opt.insertNuke': 'Add rule: drop all query parameters',
  'opt.insertNukeHint':
    'Limit it to one site with ||example.com^, or exempt one with @@||example.com^$removeparam.',
  'opt.nukeUnguarded':
    'All query parameters are dropped, with no exceptions. Pages identified by a parameter (?v=, ?id=) will merge into a single entry.',

  'sub.section': 'Rule lists',
  'sub.hint': 'List rules combine with yours. To override one, add an @@ exception.',
  'sub.presetAdguardName': 'AdGuard URL Tracking Protection',
  'sub.presetAdguardDesc': 'About 2,500 tracking parameters. Updated weekly.',
  // The key still says "supplement" and the value no longer does, on purpose. Internally the
  // file *is* a supplement — it exists to carry what upstream omits or ships in a form uBO
  // voids, which is why `checkSupplementPairing` and its own `! Description:` are relational.
  // A name in the UI cannot be: this row sits first, works with no permission and no network,
  // and can be the only list you subscribe to — in which case "supplement" would be relative
  // to a list you never took. So the provenance stays in the code and the user gets a name
  // that stands on its own, in the same `<project> <scope>` shape as the AdGuard row above.
  'sub.presetSupplementName': 'Read Later built-in rules',
  'sub.presetSupplementDesc':
    '32 tracking parameters plus 9 site rules. Updates with the extension; needs no permission.',
  'sub.addPlaceholder': 'https://example.org/list.txt',
  'sub.add': 'Subscribe',
  'sub.enabled': 'Enabled',
  'sub.autoUpdate': 'Auto-update',
  'sub.counts': '{active} rules',
  'sub.countsNotApplicable': '{n} not applicable',
  'sub.countsUnsupported': '{n} skipped',
  'sub.notApplicableTip': 'Scoped to request types a saved page is never one of.',
  'sub.unsupportedTip': 'Uses options this extension does not implement.',
  'sub.skippedGroup': '{count} lines · {lines}',
  'sub.skippedParams': 'Affects: {params}',
  'sub.denyallowExplain': 'uBlock Origin ignores these lines too.',
  'sub.denyallowCovered': 'The built-in rules already cover these parameters.',
  'sub.denyallowUncovered': 'Subscribing to Read Later built-in rules covers these parameters.',
  'sub.updated': 'Updated {when}',
  'sub.never': 'Not fetched yet',
  'sub.updateNow': 'Update',
  'sub.updating': 'Updating…',
  'sub.view': 'View rules',
  'sub.hide': 'Hide',
  'sub.remove': 'Unsubscribe',
  'sub.diff': '+{added} −{removed}',
  'sub.diffCapped': 'First {shown} of {total}.',
  'sub.error': 'Update failed: {message}. Still using the last successful fetch.',
  'sub.needsPermission': 'Subscribing to an http(s) URL requires permission to read that address.',
  'sub.denied': 'Permission denied. Nothing was fetched.',
  'sub.failed': 'Could not subscribe: {message}',
  'sub.invalidUrl': 'That is not a valid URL.',
  'sub.duplicate': 'Already subscribed to that URL.',
  'sub.added': 'Subscribed to {name}. {active} rules active.',
  'sub.updateDone': '{name} updated: +{added} −{removed}',
  'sub.updateFailed': '{name}: update failed ({message})',
  'sub.removed': 'Unsubscribed from {name}.',
  // Unsubscribing has its own failure text: reporting it with the *subscribe* failure told the
  // user the opposite of what happened.
  'sub.removeFailed': 'Could not unsubscribe from {name}: {message}',
  // The list is gone but the site permission could not be handed back. Said plainly, because the
  // unsubscribe did succeed and the only thing left over is a permission the user can revoke.
  'sub.removedKeptPermission':
    'Unsubscribed from {name}, but access to {origin} could not be given back. Remove it from the extension’s site access if you want it gone.',
  'sub.confirmRemove': 'Unsubscribe from {name}?',
  'sub.bundled': 'Bundled',
  'sub.custom': 'Custom',

  'opt.testerLabel': 'Test a URL',
  'opt.testerHint': 'Uses the rules above, including unsaved edits.',
  'opt.testerPlaceholder': 'https://example.com/article?utm_source=x&id=7',
  'opt.testerKey': 'Dedup key',
  'opt.testerKept': 'Kept',
  'opt.testerRemoved': 'Removed',
  'opt.testerSpared': 'Kept by exception',
  'opt.testerNoChange': 'No parameters removed.',
  'opt.testerInvalid': 'Not an http(s) URL.',
  'opt.testerSourceUser': 'My rules',

  'opt.rekeySection': 'Recompute dedup keys',
  'opt.rekeyHint':
    'Items keep the key they were saved with. Recompute to apply the current rules to them.',
  'opt.rekeyPreview': 'Preview',
  'opt.rekeyPlanClean': 'No changes.',
  'opt.rekeyPlan': '{rekeyed} items would be re-keyed, {merged} merged.',
  'opt.rekeyLosing':
    'Merging keeps one URL per key, so these {n} would be removed. This cannot be undone.',
  'opt.rekeyConfirm': 'Recompute',
  'opt.rekeyCancel': 'Cancel',
  'opt.rekeyDone': '{rekeyed} re-keyed, {merged} merged.',
  'opt.rekeyStale':
    'Something changed while this preview was open, so the recompute would now remove {n} URLs it did not list. Nothing was written — check the updated list below.',

  // Was `opt.displaySection`. Three of the four controls in this group are behaviour, not
  // display, and adding a second one made "Display" the wrong word for it.
  'opt.behaviourSection': 'Behaviour',
  'opt.badgeLabel': 'Show the unread count on the toolbar icon',
  'opt.closeAfterSave': 'Close the tab after saving the current page',
  'opt.closeAfterSaveHint':
    'Saving a link never closes anything. A last remaining tab is replaced by a new tab rather than closed.',
  'opt.openInCurrentTab': 'Open items in the current tab',
  'opt.openInCurrentTabHint':
    'Alt-click opens a new tab instead. Ctrl-click and middle-click still open in the background.',
  'opt.menuPrefix': 'Right-click menu prefix',
  'opt.menuPrefixPreview': 'Menu shows:',
  'opt.menuPrefixNever':
    'Waiting for the extension to apply this. If it stays here, switch the extension off and back on from the extensions page.',
  'opt.menuPrefixStale':
    'The menu still shows “{titles}”. If it stays here, switch the extension off and back on from the extensions page.',
  'opt.menuPrefixHint':
    'The browser sorts extension entries by title, so a leading “1” or “A” moves ours up. Up to 16 characters; %s is removed.',
  'opt.shortcutButton': 'Change keyboard shortcuts',
  'opt.shortcutHint':
    'No shortcut is set out of the box. Bind your own for saving the current page and for opening this list.',

  'opt.dataSection': 'Data',
  'opt.dataHint': 'Exports the unread list only. Settings and the session archive are not included.',
  'opt.export': 'Export JSON',
  'opt.import': 'Import JSON',
  'opt.clearAll': 'Delete all items',
  'opt.clearConfirm': 'Delete all {unread} unread and {archived} archived items? This cannot be undone.',
  'opt.exported': 'Exported {n} items',
  'opt.importDone': 'Import done: {created} added, {merged} merged, {skipped} skipped',
  'opt.importFailed': 'Import failed: {message}',
  'opt.importInvalidObject': 'The file does not contain a JSON object.',
  'opt.importMissingItems': 'The backup is missing its items array.',
  'opt.importNewerSchema': 'This backup was created by a newer, unsupported version.',
  'opt.cleared': 'All items deleted (settings and rules kept)',
} as const;

export type MessageKey = keyof typeof EN;

/** Every key in the catalogue. Handy for tooling and for coverage assertions. */
export const MESSAGE_KEYS = Object.keys(EN) as readonly MessageKey[];

const ZH: Record<MessageKey, string> = {
  'app.loading': '读取中…',
  'app.listTitle': 'Read Later —— 待读列表',

  'nav.sidePanel': '侧栏',
  'nav.sidePanelTip': '在侧边栏打开，阅读时保持展开',
  'nav.fullPage': '全屏',
  'nav.fullPageTip': '在标签页中打开完整列表',
  'nav.settings': '设置',
  'nav.settingsTip': '设置',
  'nav.languageTip': '切换语言',

  'err.storageTitle': '存储写入失败',
  'err.quotaTitle': '存储已满',
  'err.quotaDetail': '先导出备份，再删掉一些条目 —— 或者取消订阅某个规则列表。',
  'err.exportBackup': '导出备份',
  'err.dismiss': '忽略',

  'search.placeholder': '搜索标题或链接',

  'view.unread': '未读 {n}',
  'view.archived': '已归档 {n}',
  'view.archivedTip': '本次会话内点开过的条目，关闭浏览器时清空。',

  'ctrl.fieldAdded': '添加时间',
  'ctrl.fieldUpdated': '更新时间',
  'ctrl.fieldTipAdded': '按添加时间排序',
  'ctrl.fieldTipUpdated': '按最后更新时间排序',
  'ctrl.sortTipAsc': '最旧在前',
  'ctrl.sortTipDesc': '最新在前',
  'ctrl.groupOn': '分组',
  'ctrl.groupOff': '平铺',
  'ctrl.groupTip': '按域名分组',
  'ctrl.actions': '操作',
  'ctrl.actionsTipOn': '隐藏「复制」和「删除」按钮',
  'ctrl.actionsTipOff': '在每一行显示「复制」和「删除」',
  'ctrl.batch': '批量',

  'batch.selectAll': '全选',
  'batch.clearSelection': '取消全选',
  'batch.selected': '已选 {n} 条',
  'batch.delete': '删除',
  'batch.archive': '归档',
  'batch.restore': '放回',
  'batch.exit': '退出',

  'row.copy': '复制',
  'row.restore': '放回',
  'row.delete': '删除',
  'row.untitled': '(无标题)',
  'row.progressTip': '阅读位置 —— 打开时浏览器会尝试返回这里',
  'row.progressNoAnchorTip': '导入的百分比。没有锚点文字，打开时会停在页首。',
  'row.noProgressTip': '没有保存阅读位置',
  'row.addedAt': '收藏于 {date}',

  'empty.noMatch': '没有匹配的条目。',
  'empty.archived': '本次会话还没有归档条目。关闭浏览器时归档会清空。',
  'empty.unread': '还没有收纳任何东西。右键页面或链接选「稍后再读」。',

  'foot.usage': '{bytes} / {limit}',
  'foot.deleted': '已删除 {n} 条',
  'foot.undoTip': '原样放回，包括归档位置。到下次删除前有效。',

  'card.saveTitle': '收纳到待读？',
  'card.updateTitle': '更新这个条目？',
  'card.cancel': '取消',
  'card.confirmSave': '确认收纳',
  'card.confirmUpdate': '更新',
  'card.confirmSaveClose': '收纳并关闭',
  'card.confirmUpdateClose': '更新并关闭',
  'card.untitled': '(无标题)',
  'card.restorable': '进度 {percent} · 浏览器会尝试恢复位置',
  'card.notRestorable': '此页面无法保存阅读位置（{reason}）',
  'card.hintUseLink': '提示：右键具体链接可直接收纳该文章',
  'card.existing': '已在列表中',
  'card.existingWithProgress': '已在列表中（原进度 {percent}）',
  'card.existingArchived': '已在归档中，将放回未读',

  'toast.saved': '已收纳到待读',
  'toast.updated': '已在列表中，已更新',
  'toast.undo': '撤销',

  'reason.feedRole': '页面含 role="feed"',
  'reason.noAnchor': '视窗顶部没有可用作锚点的连续文本',
  'reason.anchorNotUnique': '锚点文本在页面内不唯一',
  'reason.noFragmentSupport': '此浏览器不支持 text fragment',

  'menu.savePage': '稍后再读（当前页）',
  'menu.saveLink': '稍后再读此链接',

  'opt.title': 'Read Later 设置',
  'opt.lede': '全部数据保存在本地，不上传。',

  'opt.langSection': '语言',
  'opt.langHint': '浏览器界面里显示的扩展名称始终跟随浏览器语言。',
  'opt.langAuto': '自动',
  'opt.langEn': 'English',
  'opt.langZh': '中文',

  'opt.storageSection': '存储',
  'opt.storageHint': '你的条目、设置、以及每个订阅列表的文本共用同一个 10 MB 上限。超出的保存会失败，并且会明确告诉你。',
  'opt.statBytes': '已占用',
  'opt.statLimit': '上限',
  'opt.storageFreeHint':
    '腾空间的办法：先在下面的「数据」里导出备份，再删条目。那个文件之后可以再导入回来。',
  'opt.statUnread': '未读',
  'opt.statArchived': '归档（本次会话）',
  'opt.statLists': '其中规则列表',
  'opt.lastWriteError': '上次写入失败：{message}',

  'opt.filtersSection': '过滤规则',
  'opt.filtersHint': 'uBlock Origin / AdGuard 语法，仅支持 $removeparam。默认不启用任何规则。',
  'opt.filtersDocsLabel': '语法参考',
  'opt.filtersEmptyLede': '当前没有启用任何规则，因此每个 query 参数都算 URL 的一部分。',
  'opt.filtersMine': '我的规则',
  'opt.filterSave': '保存',
  'opt.filterDiscard': '放弃修改',
  'opt.filterSaved': '已保存。用下面的「重算去重键」应用到已有条目。',
  'opt.errLine': '第 {line} 行：{message}',
  'opt.insertNuke': '添加规则：剥掉所有 query 参数',
  'opt.insertNukeHint': '用 ||example.com^ 限定到单个站点，或用 @@||example.com^$removeparam 豁免某个站点。',
  'opt.nukeUnguarded':
    '所有 query 参数都会被剥掉，且没有任何豁免。靠参数区分内容的页面（?v=、?id=）会被合并成一条。',

  'sub.section': '规则列表',
  'sub.hint': '列表规则与你的规则叠加生效。要压过某一条，添加一条 @@ 例外。',
  'sub.presetAdguardName': 'AdGuard URL Tracking Protection',
  'sub.presetAdguardDesc': '约 2,500 个 tracking 参数，每周更新。',
  'sub.presetSupplementName': 'Read Later 内置规则',
  'sub.presetSupplementDesc': '32 个 tracking 参数 + 9 条站点规则，随扩展更新，无需授权。',
  'sub.addPlaceholder': 'https://example.org/list.txt',
  'sub.add': '订阅',
  'sub.enabled': '启用',
  'sub.autoUpdate': '自动更新',
  'sub.counts': '{active} 条规则',
  'sub.countsNotApplicable': '{n} 条不适用',
  'sub.countsUnsupported': '{n} 条已跳过',
  'sub.notApplicableTip': '限定了被保存的页面不可能属于的请求类型。',
  'sub.unsupportedTip': '用到了本扩展未实现的修饰符。',
  'sub.skippedGroup': '{count} 行 · {lines}',
  'sub.skippedParams': '影响：{params}',
  'sub.denyallowExplain': 'uBlock Origin 同样会忽略这些行。',
  'sub.denyallowCovered': '内置规则已覆盖这些参数。',
  'sub.denyallowUncovered': '订阅「Read Later 内置规则」即可覆盖这些参数。',
  'sub.updated': '{when} 更新',
  'sub.never': '尚未拉取',
  'sub.updateNow': '更新',
  'sub.updating': '更新中…',
  'sub.view': '查看规则',
  'sub.hide': '收起',
  'sub.remove': '取消订阅',
  'sub.diff': '+{added} −{removed}',
  'sub.diffCapped': '共 {total} 条，显示前 {shown} 条。',
  'sub.error': '更新失败：{message}。仍在使用上次成功拉取的规则。',
  'sub.needsPermission': '订阅 http(s) URL 需要授权访问该地址。',
  'sub.denied': '授权被拒绝，未拉取任何内容。',
  'sub.failed': '订阅失败：{message}',
  'sub.invalidUrl': '这不是一个合法的 URL。',
  'sub.duplicate': '这个 URL 已经订阅过了。',
  'sub.added': '已订阅 {name}，{active} 条规则生效。',
  'sub.updateDone': '{name} 已更新：+{added} −{removed}',
  'sub.updateFailed': '{name}：更新失败（{message}）',
  'sub.removed': '已取消订阅 {name}。',
  'sub.removeFailed': '取消订阅「{name}」失败：{message}',
  'sub.removedKeptPermission':
    '已取消订阅 {name}，但没能交还对 {origin} 的访问权限。如果想彻底去掉，请到扩展的网站访问权限里移除。',
  'sub.confirmRemove': '取消订阅「{name}」？',
  'sub.bundled': '内置',
  'sub.custom': '自定义',

  'opt.testerLabel': '测试 URL',
  'opt.testerHint': '使用上面的规则，包含未保存的修改。',
  'opt.testerPlaceholder': 'https://example.com/article?utm_source=x&id=7',
  'opt.testerKey': '去重键',
  'opt.testerKept': '保留',
  'opt.testerRemoved': '剥掉',
  'opt.testerSpared': '被例外保留',
  'opt.testerNoChange': '没有参数被剥掉。',
  'opt.testerInvalid': '不是 http(s) URL。',
  'opt.testerSourceUser': '我的规则',

  'opt.rekeySection': '重算去重键',
  'opt.rekeyHint': '已有条目沿用保存时的键。重算一次即可把当前规则应用到它们身上。',
  'opt.rekeyPreview': '预览',
  'opt.rekeyPlanClean': '不会有任何变化。',
  'opt.rekeyPlan': '{rekeyed} 条会换键，{merged} 条会被合并。',
  'opt.rekeyLosing': '合并后每个键只保留一个 URL，因此这 {n} 个会被移除，且无法恢复。',
  'opt.rekeyConfirm': '重算',
  'opt.rekeyCancel': '取消',
  'opt.rekeyDone': '{rekeyed} 条换了键，{merged} 条被合并。',
  'opt.rekeyStale':
    '预览打开期间有东西变了，现在重算会移除 {n} 个它没有列出的 URL。什么都没有写入 —— 请看下面刷新后的清单。',

  'opt.behaviourSection': '行为',
  'opt.badgeLabel': '在工具栏图标上显示未读数',
  'opt.closeAfterSave': '收纳当前页之后关闭该标签页',
  'opt.closeAfterSaveHint': '收纳链接时不会关闭任何标签页。若这是最后一个标签页，会被替换成新标签而不是关掉。',
  'opt.openInCurrentTab': '在当前标签页打开条目',
  'opt.openInCurrentTabHint': 'Alt 点击改为新开标签页。Ctrl 点击和中键点击仍然在后台打开。',
  'opt.menuPrefix': '右键菜单前缀',
  'opt.menuPrefixPreview': '菜单显示：',
  'opt.menuPrefixNever': '正在等待扩展应用此设置。若一直停在这里，去扩展管理页把本扩展的开关关掉再打开。',
  'opt.menuPrefixStale': '菜单目前仍显示「{titles}」。若一直停在这里，去扩展管理页把本扩展的开关关掉再打开。',
  'opt.menuPrefixHint':
    '浏览器按标题给扩展条目排序，所以开头加「1」或「A」可以让它靠前。最多 16 个字符，%s 会被移除。',
  'opt.shortcutButton': '修改快捷键',
  'opt.shortcutHint': '默认不带任何快捷键。可以自己给「收纳当前页」和「打开列表」各绑一个。',

  'opt.dataSection': '数据',
  'opt.dataHint': '仅导出未读列表，不包含设置和本次会话的归档。',
  'opt.export': '导出 JSON',
  'opt.import': '导入 JSON',
  'opt.clearAll': '清空全部条目',
  'opt.clearConfirm': '确定要删除全部 {unread} 条未读和 {archived} 条归档吗？此操作不可撤销。',
  'opt.exported': '已导出 {n} 条',
  'opt.importDone': '导入完成：新增 {created} 条，合并 {merged} 条，跳过 {skipped} 条',
  'opt.importFailed': '导入失败：{message}',
  'opt.importInvalidObject': '文件内容不是 JSON 对象。',
  'opt.importMissingItems': '备份中缺少 items 数组。',
  'opt.importNewerSchema': '此备份由当前不支持的更新版本生成。',
  'opt.cleared': '已清空全部条目（设置和规则保留）',
};

const CATALOGS: Record<Locale, Record<MessageKey, string>> = { en: EN, zh: ZH };

/** `auto` follows the browser UI language; anything starting with `zh` gets Chinese. */
export function resolveLocale(pref: LocalePref, browserLanguage?: string): Locale {
  if (pref !== 'auto') return pref;
  const language = (browserLanguage ?? (typeof navigator === 'undefined' ? 'en' : navigator.language)) || 'en';
  return language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function t(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const template = CATALOGS[locale][key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function makeTranslate(locale: Locale): Translate {
  return (key, vars) => t(locale, key, vars);
}

/** The label shown on the language toggle: the language it will switch *to*. */
export function nextLocaleLabel(locale: Locale): string {
  return locale === 'zh' ? 'EN' : '中';
}

/**
 * The `lang` attribute for `<html>`.
 *
 * The HTML shells ship with `lang="en"` because English is this catalogue's source of
 * truth, and each root component corrects it once the locale has been read from storage.
 * It is worth doing rather than hardcoding: `lang` drives CJK glyph selection (the same
 * code points render differently for zh / ja under Han unification), hyphenation, and
 * screen-reader pronunciation — none of which the font stack can fix on its own.
 */
export function htmlLang(locale: Locale): 'en' | 'zh-CN' {
  return locale === 'zh' ? 'zh-CN' : 'en';
}
