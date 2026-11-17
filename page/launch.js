(() => {
  'use strict';

  const status = document.getElementById('launch-status');
  const errorBox = document.getElementById('launch-error');
  const retry = document.getElementById('launch-retry');
  let generation = 0;

  function showError(message) {
    status.textContent = '未能打开仪表台';
    errorBox.textContent = message;
    errorBox.hidden = false;
    retry.hidden = false;
  }

  async function launch() {
    const attempt = ++generation;
    let expired = false;
    errorBox.hidden = true;
    retry.hidden = true;
    status.textContent = '正在等待 Magpie 就绪…';
    const deadline = setTimeout(() => {
      if (attempt !== generation) return;
      expired = true;
      showError('Magpie 在 10 秒内未完成桥接或选项读取。请检查插件服务，再重新连接。');
    }, 10000);

    try {
      const magpie = window.magpie;
      if (!magpie || !magpie.ready || typeof magpie.ready.then !== 'function') {
        throw new Error('未读取到 Magpie bridge。请从 Magpie 的插件页面打开此入口。');
      }
      await magpie.ready;
      if (expired || attempt !== generation) return;
      if (!magpie.options || typeof magpie.options.get !== 'function') throw new Error('Magpie 未提供插件端口选项接口。');
      status.textContent = '正在读取服务入口…';
      // Host options are used for the port only. Runtime settings belong to api/settings.
      const options = await magpie.options.get();
      if (expired || attempt !== generation) return;
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('插件端口选项不是有效对象。');
      const rawPort = options.port === undefined ? 3430 : options.port;
      if ((typeof rawPort !== 'number' && typeof rawPort !== 'string') || !/^\d+$/.test(String(rawPort))) {
        throw new Error('插件端口须为 1–65535 之间的整数。');
      }
      const port = Number(rawPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('插件端口须为 1–65535 之间的整数。');

      const service = magpie.service;
      if (service != null && (typeof service !== 'string' || (service && !service.trim()))) throw new Error('Magpie 服务入口不是有效地址。');
      const target = new URL(service || `http://127.0.0.1:${port}/`, location.href);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Magpie 服务入口须为不含账号的 HTTP(S) 地址。');
      if (!target.pathname.endsWith('/')) target.pathname += '/';
      const theme = magpie.theme;
      const dark = theme && typeof theme.dark === 'boolean' ? theme.dark
        : document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
      const lang = theme?.lang || document.documentElement.lang || 'zh-CN';
      if (typeof lang !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang)) throw new Error('Magpie 的界面语言标记无效。');
      target.searchParams.set('theme', dark ? 'dark' : 'light');
      target.searchParams.set('lang', lang);
      status.textContent = '正在前往仪表台，连接状态由管理服务确认…';
      location.replace(target.href);
    } catch (error) {
      if (attempt === generation && !expired) showError(error instanceof Error ? error.message : '启动入口发生异常，请重新打开插件页面。');
    } finally {
      clearTimeout(deadline);
    }
  }

  retry.addEventListener('click', launch);
  launch();
})();
