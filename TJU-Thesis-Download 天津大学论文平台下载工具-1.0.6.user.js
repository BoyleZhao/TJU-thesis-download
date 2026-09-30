// ==UserScript==
// @name         TJU-Thesis-Download 天津大学论文平台下载工具
// @namespace    https://greasyfork.org/zh-CN/scripts/tju-thesis-download
// @supportURL   https://github.com/BoyleZhao/TJU-thesis-download
// @homepageURL  https://github.com/BoyleZhao/TJU-thesis-download
// @version      1.0.6
// @description  天津大学论文平台下载工具，请勿传播下载的文件，否则后果自负。
// @author       Modified for TJU
// @match        https://theses.lib.tju.edu.cn/rd/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=tju.edu.cn
// @require      https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
// @license      GNU GPLv3
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      theses.lib.tju.edu.cn
// @history      1.0.6 精准自动滚动：逐页 scrollIntoView + 等待 blob 图片出现
// ==/UserScript==

(function () {
  'use strict';

  if (!location.hash.includes('/reader/')) return;

  // ─────────────────────────────────────────────
  // 工具函数
  // ─────────────────────────────────────────────
  const print = (...args) => console.log('[TJU-Thesis-Download]', ...args);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ─────────────────────────────────────────────
  // 拦截 URL.createObjectURL / revokeObjectURL
  // 必须在页面脚本之前执行（document-start）
  // ─────────────────────────────────────────────
  const _blobStore = new Map(); // blobUrl -> Blob
  const _blobOrder = [];        // 按创建顺序

  function interceptBlobURL() {
    try {
      const win = unsafeWindow;
      const origCreate = win.URL.createObjectURL.bind(win.URL);
      const origRevoke = win.URL.revokeObjectURL.bind(win.URL);

      win.URL.createObjectURL = function (obj) {
        const url = origCreate(obj);
        if (obj instanceof Blob && (obj.type.startsWith('image/') || obj.type === '')) {
          _blobStore.set(url, obj);
          _blobOrder.push(url);
          print(`📸 捕获blob #${_blobOrder.length} size=${obj.size} type=${obj.type||'unknown'}`);
        }
        return url;
      };

      win.URL.revokeObjectURL = function (url) {
        if (_blobStore.has(url)) {
          print(`🔒 阻止revoke: ${url.substring(0, 50)}`);
          return; // 保留我们的引用
        }
        return origRevoke(url);
      };

      print('✅ blob URL 拦截器已安装');
    } catch (e) {
      print('⚠️ blob拦截失败:', e.message);
    }
  }

  // ─────────────────────────────────────────────
  // 获取总页数
  // ─────────────────────────────────────────────
  function getTotalPage() {
    for (const sel of [
      '#totalPages', '.totalPages', '#pageCount', '.page-count',
      '.total-page', '[class*="totalPage"]', '[class*="total-page"]',
      '[class*="total_page"]', 'span[class*="total"]'
    ]) {
      const el = document.querySelector(sel);
      if (el) {
        const n = parseInt(el.textContent.replace(/\D/g, ''), 10);
        if (!isNaN(n) && n > 0) { print(`总页数 from "${sel}":`, n); return n; }
      }
    }
    const m = document.body.innerText.match(/共\s*(\d+)\s*页/) ||
              document.body.innerText.match(/\/\s*(\d+)/);
    return m ? parseInt(m[1]) : null;
  }

  // ─────────────────────────────────────────────
  // 等待某个页面 div 内出现 blob 图片，超时则放弃
  // ─────────────────────────────────────────────
  function waitForPageImage(pageDiv, timeoutMs = 8000) {
    return new Promise(resolve => {
      // 已经有图片了
      if (pageDiv.querySelector('img[src^="blob:"]')) { resolve(true); return; }

      const timer = setTimeout(() => { ob.disconnect(); resolve(false); }, timeoutMs);

      const ob = new MutationObserver(() => {
        if (pageDiv.querySelector('img[src^="blob:"]')) {
          clearTimeout(timer);
          ob.disconnect();
          resolve(true);
        }
      });
      ob.observe(pageDiv, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    });
  }

  // ─────────────────────────────────────────────
  // 核心：逐页滚动触发懒加载
  // 结构已知：div.page.mobilePage > div.content > img
  // ─────────────────────────────────────────────
  async function triggerAllPagesLoad(totalPage, msgEl) {
    print('开始逐页滚动加载...');

    // 等待页面 div 全部渲染出来（至少有 totalPage 个）
    msgEl.textContent = '等待页面结构就绪...';
    await waitForPageDivs(totalPage);

    const pageDivs = [...document.querySelectorAll('div.page.mobilePage')];
    print(`找到 ${pageDivs.length} 个 div.page.mobilePage`);

    if (pageDivs.length === 0) {
      // 兜底：用 window 滚动
      print('未找到页面div，使用window滚动兜底');
      await fallbackWindowScroll(totalPage, msgEl);
      return;
    }

    // 逐页滚动
    for (let i = 0; i < pageDivs.length; i++) {
      const div = pageDivs[i];
      const alreadyLoaded = div.querySelector('img[src^="blob:"]');

      if (!alreadyLoaded) {
        // 滚到该页，触发懒加载
        div.scrollIntoView({ behavior: 'instant', block: 'center' });
        // 等待图片出现，最多等 8 秒
        const ok = await waitForPageImage(div, 8000);
        if (!ok) print(`⚠️ 第 ${i+1} 页超时未加载`);
      }

      // 每5页更新一次进度（避免频繁更新拖慢）
      if (i % 5 === 0 || i === pageDivs.length - 1) {
        const loaded = _blobOrder.length;
        msgEl.textContent = `加载中 ${Math.min(loaded, totalPage)}/${totalPage}`;
        print(`进度: ${i+1}/${pageDivs.length}，已捕获blob: ${loaded}`);
      }
    }

    // 滚回顶部
    window.scrollTo({ top: 0, behavior: 'instant' });
    await sleep(300);

    print(`滚动完成，共捕获 ${_blobOrder.length} 个blob`);
  }

  // 等待 div.page.mobilePage 数量达到预期
  async function waitForPageDivs(totalPage, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const count = document.querySelectorAll('div.page.mobilePage').length;
      if (count >= totalPage) { print(`页面div就绪: ${count}个`); return; }
      print(`等待页面div: ${count}/${totalPage}`);
      await sleep(500);
    }
    print(`⚠️ 等待超时，当前只有 ${document.querySelectorAll('div.page.mobilePage').length} 个页面div`);
  }

  // 兜底：window 滚动
  async function fallbackWindowScroll(totalPage, msgEl) {
    const totalH = document.documentElement.scrollHeight;
    const steps = Math.max(totalPage * 3, 30);
    for (let i = 0; i <= steps; i++) {
      window.scrollTo(0, (totalH / steps) * i);
      await sleep(100);
      if (i % 10 === 0) {
        msgEl.textContent = `滚动中 ${_blobOrder.length}/${totalPage}`;
      }
    }
    window.scrollTo(0, 0);
    await sleep(300);
  }

  // ─────────────────────────────────────────────
  // 从 DOM 补充收集（兜底）
  // ─────────────────────────────────────────────
  async function collectBlobsFromDOM() {
    const imgs = [...document.querySelectorAll('img[src^="blob:"]')];
    print(`DOM兜底收集: ${imgs.length} 个blob图片`);
    const results = [];
    for (const img of imgs) {
      const url = img.src;
      if (_blobStore.has(url)) {
        results.push({ url, blob: _blobStore.get(url) });
      } else {
        try {
          const res = await fetch(url);
          const blob = await res.blob();
          results.push({ url, blob });
        } catch (e) {
          print(`fetch blob失败: ${url.substring(0, 50)}`, e.message);
        }
      }
    }
    return results;
  }

  // ─────────────────────────────────────────────
  // Blob → base64
  // ─────────────────────────────────────────────
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = () => resolve(reader.result);
      reader.onerror  = () => reject(new Error('FileReader失败'));
    });
  }

  function getImageOrientation(base64) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload  = () => resolve(img.width > img.height ? 'landscape' : 'portrait');
      img.onerror = () => resolve('portrait');
      img.src = base64;
    });
  }

  // ─────────────────────────────────────────────
  // 合并 PDF
  // ─────────────────────────────────────────────
  async function solvePDF(pages, msgEl) {
    msgEl.textContent = '拼接PDF...';
    const doc = new jspdf.jsPDF({ format: 'a4', orientation: 'portrait' });
    for (let i = 0; i < pages.length; i++) {
      const { base64, orientation } = pages[i];
      const land = orientation === 'landscape';
      if (i > 0) doc.addPage('a4', orientation);
      doc.addImage(base64, 'JPEG', 0, 0, land ? 297 : 210, land ? 210 : 297);
      if (i % 10 === 0 || i === pages.length - 1)
        msgEl.textContent = `拼接中 ${i+1}/${pages.length}`;
    }
    msgEl.textContent = '保存中...';
    const filename = (document.title || 'thesis').replace(/[\\/:*?"<>|]/g, '_') + '.pdf';
    doc.save(filename);
    msgEl.textContent = '✅ 完成！';
    print('PDF saved:', filename);
  }

  // ─────────────────────────────────────────────
  // 主流程
  // ─────────────────────────────────────────────
  async function doDownload(msgEl) {
    const totalPage = getTotalPage();
    if (!totalPage) throw new Error('无法获取总页数，请等页面完全加载');
    print(`总页数: ${totalPage}`);

    // 第一步：逐页滚动触发懒加载
    msgEl.textContent = '触发页面加载...';
    await triggerAllPagesLoad(totalPage, msgEl);
    await sleep(800); // 最后一批图片渲染缓冲

    // 第二步：收集 blob
    msgEl.textContent = '收集图片数据...';
    let blobs = [];

    if (_blobOrder.length > 0) {
      print(`拦截器共捕获 ${_blobOrder.length} 个blob`);
      // 去重：同一页可能因重复滚动触发多次加载，取最新的 totalPage 个
      // 用 Map 按 url 去重后取最后 totalPage 个
      const unique = [...new Map(_blobOrder.map(url => [url, url])).values()];
      const urls = unique.slice(-totalPage);
      blobs = urls.map(url => ({ url, blob: _blobStore.get(url) })).filter(b => b.blob);
    }

    // DOM 兜底补充
    if (blobs.length < totalPage) {
      print(`拦截器不足(${blobs.length}/${totalPage})，DOM兜底...`);
      const domBlobs = await collectBlobsFromDOM();
      const urlSet = new Set(blobs.map(b => b.url));
      for (const b of domBlobs) {
        if (!urlSet.has(b.url)) { blobs.push(b); urlSet.add(b.url); }
      }
    }

    if (blobs.length === 0)
      throw new Error(`未收集到图片。拦截器: ${_blobOrder.length}个，DOM: ${document.querySelectorAll('img[src^="blob:"]').length}个`);

    if (blobs.length < totalPage) {
      print(`⚠️ 只收集到 ${blobs.length}/${totalPage} 页`);
      msgEl.textContent = `⚠️ 仅${blobs.length}/${totalPage}页，3秒后继续...`;
      await sleep(3000);
    }

    print(`开始转换 ${blobs.length} 个blob → base64`);

    // 第三步：转换 base64
    const pages = [];
    for (let i = 0; i < blobs.length; i++) {
      if (i % 10 === 0) msgEl.textContent = `转换中 ${i+1}/${blobs.length}`;
      const base64 = await blobToBase64(blobs[i].blob);
      const orientation = await getImageOrientation(base64);
      pages.push({ base64, orientation });
    }

    // 第四步：合并 PDF
    await solvePDF(pages, msgEl);
  }

  // ─────────────────────────────────────────────
  // UI
  // ─────────────────────────────────────────────
  function initUI() {
    if (document.getElementById('tju-dl-btn-wrap')) return;

    GM_addStyle(`
      #tju-dl-btn-wrap {
        position: fixed; top: 60px; right: 18px; z-index: 99999;
        display: flex; flex-direction: column; align-items: stretch; gap: 6px;
        font-family: sans-serif;
      }
      #tju-dl-btn {
        padding: 8px 18px; background: #1a56db; color: #fff;
        border: none; border-radius: 6px; cursor: pointer; font-size: 14px;
        box-shadow: 0 2px 8px rgba(0,0,0,.3); transition: background .2s;
        white-space: nowrap;
      }
      #tju-dl-btn:hover    { background: #1648c0; }
      #tju-dl-btn:disabled { background: #888; cursor: not-allowed; }
      #tju-dl-msg {
        text-align: center; font-size: 12px; color: #222;
        background: rgba(255,255,255,.92); border-radius: 4px;
        padding: 2px 6px; min-height: 18px; max-width: 160px;
        word-break: break-all;
      }
    `);

    const wrap = document.createElement('div');
    wrap.id = 'tju-dl-btn-wrap';
    const btn = document.createElement('button');
    btn.id = 'tju-dl-btn';
    btn.textContent = '⬇ 下载PDF';
    const msg = document.createElement('span');
    msg.id = 'tju-dl-msg';
    wrap.append(btn, msg);
    document.body.appendChild(wrap);

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      msg.textContent = '准备中...';
      try { await doDownload(msg); }
      catch (e) {
        console.error('[TJU]', e);
        msg.textContent = `❌ ${e.message}`;
      } finally { btn.disabled = false; }
    });
  }

  // ─────────────────────────────────────────────
  // 入口
  // ─────────────────────────────────────────────
  interceptBlobURL();

  function waitForAppReady() {
    print('等待SPA渲染...');
    const ob = new MutationObserver(() => {
      const app = document.querySelector('#app,#root,[id*="app"]');
      if (app && app.children.length > 0 && app.textContent.trim().length > 50) {
        ob.disconnect();
        print('SPA就绪，注入按钮');
        initUI();
      }
    });
    ob.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { ob.disconnect(); initUI(); }, 5000);
  }

  waitForAppReady();

})();