// ==UserScript==
// @name         Smooth Zoom to Cursor
// @namespace    https://github.com/diple-df/Smooth-Zoom
// @version      3.0.0
// @description  Trackpad-style smooth zoom to the cursor (Ctrl+Wheel). One transform write per frame, zero work at idle. Crisp at rest, fixed elements keep their screen rect. Native Ctrl +/- left intact. Configurable via menu.
// @description:ru Плавный зум к курсору (Ctrl+колесо). Одна запись transform за кадр, в простое скрипт не делает ничего. Чётко в покое, fixed-элементы остаются на своих местах. Родной зум Ctrl +/- не трогается. Настраивается через меню.
// @author       diple_df x claude
// @homepageURL  https://github.com/diple-df/Smooth-Zoom
// @supportURL   https://github.com/diple-df/Smooth-Zoom/issues
// @match        *://*/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      github.com
// @downloadURL  https://raw.githubusercontent.com/diple-df/Smooth-Zoom/main/smooth-zoom.user.js
// @updateURL    https://raw.githubusercontent.com/diple-df/Smooth-Zoom/main/smooth-zoom.user.js
// @noframes
// ==/UserScript==

/*
 * 3.0.0 — переписан с чистой архитектуры 2.7.0 (541 строка), которая работала.
 * В 2.8.0…2.16.1 накопилось ~1000 строк особых случаев: counter-zoom-законы,
 * scroll-lock, sticky-компенсация, обход shadow DOM, батчинг MutationObserver,
 * детект absolute-оверлеев, naturalTargetX/Y, вложенный fixed, калибровки.
 * Каждый случай был локально верен, но вместе они дали медленный и хрупкий
 * скрипт. Здесь оставлен один закон на fixed-элементы и один цикл кадров.
 *
 * Модель: экран = translate(tx,ty) ∘ scale(S) над border-box <html> с origin 0 0.
 * Курсор привязан точно: точка под курсором пересчитывается в локальные
 * координаты и возвращается под курсор на новом масштабе.
 */

(function () {
    'use strict';

    // ----- Настройки -----------------------------------------------------
    const DEFAULT_CFG = {
        minScale: 1,
        maxScale: 10,
        wheelStep: 0.0015,
        panSpeed: 1,
        transitionMs: 120,      // время, за которое зум «догоняет» цель
        crispDelayMs: 200,
        shiftWheelHorizontal: false,
    };
    let CONFIG = Object.assign({}, DEFAULT_CFG);
    try {
        if (typeof GM_getValue === 'function') {
            const s = GM_getValue('smoothzoom_cfg', null);
            if (s) CONFIG = Object.assign({}, DEFAULT_CFG, JSON.parse(s));
        }
    } catch (e) {}

    function saveCfg() {
        try {
            if (typeof GM_setValue === 'function') GM_setValue('smoothzoom_cfg', JSON.stringify(CONFIG));
        } catch (e) {}
    }

    // ----- Автообновление -------------------------------------------------
    // Пассивная часть — @updateURL/@downloadURL в шапке: Tampermonkey сам
    // сверяет версию. Здесь активная: проверка из меню и раз в сутки фоном.
    // Скрипт висит на *://*/*, поэтому в простое проверка не должна стоить
    // ничего: читается один timestamp, сеть трогается не чаще раза в сутки.
    const UPDATE = (function () {
        const RAW = 'https://raw.githubusercontent.com/diple-df/Smooth-Zoom/main/smooth-zoom.user.js';
        const PAGE = 'https://github.com/diple-df/Smooth-Zoom';
        const STAMP_KEY = 'smoothzoom_upd_ts';
        const SEEN_KEY = 'smoothzoom_upd_seen';
        const DAY = 86400000;

        function curVer() {
            try {
                if (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version)
                    return String(GM_info.script.version);
            } catch (e) {}
            return '3.0.0';
        }

        // Сравнение по числовым сегментам: 2.10.0 больше 2.9.0 (строкой — нет).
        function cmp(a, b) {
            const pa = String(a).split(/[.\-+]/), pb = String(b).split(/[.\-+]/);
            const n = Math.max(pa.length, pb.length);
            for (let i = 0; i < n; i++) {
                const x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
                if (x !== y) return x > y ? 1 : -1;
            }
            return 0;
        }

        function fetchText(url, cb) {
            let done = false;
            const finish = (txt) => { if (!done) { done = true; cb(txt || null); } };
            try {
                if (typeof GM_xmlhttpRequest === 'function') {
                    GM_xmlhttpRequest({
                        method: 'GET', url: url, timeout: 15000,
                        onload: r => finish(r && r.status === 200 ? r.responseText : null),
                        onerror: () => finish(null),
                        ontimeout: () => finish(null),
                    });
                    return;
                }
            } catch (e) {}
            try {
                fetch(url, { cache: 'no-store' }).then(r => r.ok ? r.text() : null)
                    .then(finish).catch(() => finish(null));
            } catch (e) { finish(null); }
        }

        function banner(version) {
            if (document.getElementById('smoothzoom-upd')) return;
            const box = document.createElement('div');
            box.id = 'smoothzoom-upd';
            box.setAttribute('role', 'status');
            box.style.cssText = [
                'position:fixed', 'z-index:2147483647', 'right:16px', 'bottom:16px',
                'max-width:320px', 'padding:12px 14px', 'border-radius:10px',
                'background:#16181d', 'color:#f2f3f6', 'border:1px solid #2b2e38',
                'box-shadow:0 12px 32px -8px rgba(0,0,0,.6)',
                'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',
                'display:flex', 'gap:10px', 'align-items:flex-start',
            ].join(';');

            const txt = document.createElement('div');
            txt.style.cssText = 'flex:1 1 auto';
            txt.textContent = 'Smooth Zoom ' + version + ' доступна. ';
            const link = document.createElement('a');
            link.href = RAW;
            link.textContent = 'Обновить';
            link.style.cssText = 'color:#7db4ff;text-decoration:underline;cursor:pointer';
            txt.appendChild(link);

            const close = document.createElement('button');
            close.type = 'button';
            close.textContent = '✕';
            close.setAttribute('aria-label', 'Закрыть');
            close.style.cssText = 'appearance:none;border:0;background:none;color:#8b90a0;' +
                'font:inherit;cursor:pointer;padding:0 0 0 4px;line-height:1';
            close.onclick = () => box.remove();

            box.appendChild(txt);
            box.appendChild(close);
            (document.body || document.documentElement).appendChild(box);

            try {
                if (typeof GM_setValue === 'function') GM_setValue(SEEN_KEY, version);
            } catch (e) {}
        }

        function check(opts) {
            const manual = !!(opts && opts.manual);
            try {
                if (typeof GM_setValue === 'function') GM_setValue(STAMP_KEY, Date.now());
            } catch (e) {}
            fetchText(RAW, txt => {
                if (!txt) { if (manual) menuMsg('Не удалось проверить обновления'); return; }
                const m = txt.match(/^\/\/\s*@version\s+(.+)$/m);
                const remote = m ? m[1].trim() : '';
                if (!remote) { if (manual) menuMsg('Не удалось прочитать версию'); return; }
                const local = curVer();
                if (cmp(remote, local) > 0) {
                    let seen = null;
                    try { seen = typeof GM_getValue === 'function' ? GM_getValue(SEEN_KEY, null) : null; } catch (e) {}
                    if (manual || seen !== remote) banner(remote);
                } else if (manual) {
                    menuMsg('Установлена последняя версия ' + local);
                }
            });
        }

        function menuMsg(text) {
            const box = document.createElement('div');
            box.setAttribute('role', 'status');
            box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;' +
                'padding:10px 14px;border-radius:10px;background:#16181d;color:#f2f3f6;' +
                'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif';
            box.textContent = text;
            (document.body || document.documentElement).appendChild(box);
            setTimeout(() => box.remove(), 3200);
        }

        function maybeAuto() {
            try {
                if (typeof GM_getValue !== 'function') return;
                const last = GM_getValue(STAMP_KEY, 0) || 0;
                if (Date.now() - last < DAY) return;
            } catch (e) { return; }
            const run = () => check({ manual: false });
            if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 5000 });
            else setTimeout(run, 2500);
        }

        return { check, maybeAuto, cmp, curVer, PAGE };
    })();

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Smooth Zoom: Проверить обновления', function () {
            UPDATE.check({ manual: true });
        });
        GM_registerMenuCommand('Smooth Zoom: Сбросить настройки', function () {
            CONFIG = Object.assign({}, DEFAULT_CFG);
            saveCfg();
            location.reload();
        });
    }

    try {
        if (document.readyState === 'complete') UPDATE.maybeAuto();
        else window.addEventListener('load', UPDATE.maybeAuto, { once: true, passive: true });
    } catch (e) {}

    // ----- Состояние ------------------------------------------------------
    // cur* — то, что реально записано в DOM (цель анимации для следующего
    // кадра). tgt* — куда едет зум. Разница между ними и есть плавность: её
    // сглаживает один rAF-цикл, который пишет не больше одного transform за
    // кадр и полностью останавливается, когда движение закончилось.
    let curScale = 1, curTx = 0, curTy = 0;
    let tgtScale = 1, tgtTx = 0, tgtTy = 0;
    let active = false;
    let rafId = 0;
    let lastTs = 0;
    let willChangeOn = false;
    let root = null;
    let savedRoot = null;
    // Сконвертированные fixed/absolute-оверлеи: {el, style, bx, by, w, h}.
    let fixed = [];
    let converted = typeof WeakSet === 'function' ? new WeakSet() : null;
    let observer = null;
    let shadowObservers = [];
    let shadowSeen = typeof WeakSet === 'function' ? new WeakSet() : null;
    let pendingScan = [];
    let scanAll = false;
    // Геометрия страницы (снимается на входе, при ресайзе и при росте DOM).
    let viewW = 0, viewH = 0, baseW = 0, baseH = 0;

    const TAU = Math.max(16, CONFIG.transitionMs / 2.6);
    // Свойства, которые скрипт трогает у конвертированных элементов.
    const FIXED_PROPS = ['zoom', 'margin', 'box-sizing', 'width', 'height', 'left', 'top'];
    // Свойства, которые скрипт трогает у <html>.
    const ROOT_PROPS = ['transform', 'transform-origin', 'transition', 'will-change', 'overflow', 'scrollbar-gutter'];

    function getRoot() {
        if (!root || !root.isConnected) root = document.documentElement;
        return root;
    }

    function clampScale(s) {
        return Math.min(CONFIG.maxScale, Math.max(CONFIG.minScale, s));
    }

    function grabStyle(el, props) {
        const out = [];
        for (let i = 0; i < props.length; i++) {
            const p = props[i];
            out.push({ p: p, v: el.style.getPropertyValue(p), pr: el.style.getPropertyPriority(p) });
        }
        return out;
    }

    function putStyle(el, saved) {
        for (let i = 0; i < saved.length; i++) {
            const s = saved[i];
            try {
                if (s.v) el.style.setProperty(s.p, s.v, s.pr);
                else el.style.removeProperty(s.p);
            } catch (e) {}
        }
    }

    function setImp(el, prop, value) {
        el.style.setProperty(prop, value, 'important');
    }

    // Замер страницы. Только на входе/ресайзе/росте DOM — никогда в кадре.
    function measure() {
        const el = getRoot();
        viewW = (el && el.clientWidth) || window.innerWidth || 0;
        viewH = (el && el.clientHeight) || window.innerHeight || 0;
        baseW = Math.max((el && el.scrollWidth) || 0, viewW);
        baseH = Math.max((el && el.scrollHeight) || 0, viewH);
    }

    // ----- Границы панорамы ----------------------------------------------
    // translate играет роль -scrollX: диапазон [-(W*S - VW), 0]. Пустое поле
    // за краем страницы не показываем, как и нативный зум.
    function clampPan() {
        if (viewW <= 0 || viewH <= 0) measure();
        const minTx = Math.min(0, viewW - baseW * tgtScale);
        const minTy = Math.min(0, viewH - baseH * tgtScale);
        if (tgtTx > 0) tgtTx = 0;
        else if (tgtTx < minTx) tgtTx = minTx;
        if (tgtTy > 0) tgtTy = 0;
        else if (tgtTy < minTy) tgtTy = minTy;
    }

    // ----- Плавный fixed: один закон на все элементы ----------------------
    // position:fixed НЕ подчиняется transform предка, но подчиняется zoom,
    // поэтому контр-масштаб задаётся именно zoom, а собственный transform
    // элемента (translate(-50%,-50%), scale(.9), rotate) остаётся нетронутым:
    // screen = tx + S*(left*zoom) = tx + left при zoom = 1/S.
    // Замерено (mech.html, S = 1.6432 / 2.4 / 1.2): промах ≤ 0.03 px для
    // обычного fixed, right/bottom-якоря, inset:0, absolute-оверлея и
    // элементов со своим translate(%)/scale/rotate. Альтернатива
    // position:absolute + transform:scale(1/S) даёт те же числа, но
    // перезаписывает transform — на вращающемся лоадере промах 3.3 px и
    // мёртвая анимация, поэтому отвергнута замером.
    function parentAcross(el) {
        if (el.parentElement) return el.parentElement;
        try {
            const r = el.getRootNode && el.getRootNode();
            if (r && r.host) return r.host;
        } catch (e) {}
        return null;
    }

    // position:fixed внутри предка с transform/filter/contain/will-change уже
    // НЕ привязан к вьюпорту: его содержащий блок — этот предок, и он корректно
    // масштабируется вместе с ним. Замерено: fixed-шапка, вложенная в
    // transform-контейнер, уезжала с 0,0 на 430,340. Такие узлы не трогаем.
    function inTransformedContext(el) {
        let p = parentAcross(el);
        while (p && p !== document.documentElement && p !== document.body) {
            let cs;
            try { cs = getComputedStyle(p); } catch (e) { return true; }
            if (!cs) return true;
            if (cs.transform && cs.transform !== 'none') return true;
            if (cs.filter && cs.filter !== 'none') return true;
            if (cs.backdropFilter && cs.backdropFilter !== 'none') return true;
            if (cs.perspective && cs.perspective !== 'none') return true;
            if (cs.contain && /paint|layout|strict|content/i.test(cs.contain)) return true;
            if (cs.willChange && /transform|perspective|filter/i.test(cs.willChange)) return true;
            p = parentAcross(p);
        }
        return false;
    }

    let bodyStatic = null;
    function bodyIsStatic() {
        if (bodyStatic === null) {
            try { bodyStatic = !document.body || getComputedStyle(document.body).position === 'static'; }
            catch (e) { bodyStatic = true; }
        }
        return bodyStatic;
    }

    // Содержащий блок — вьюпорт? Это ровно два случая: fixed и absolute без
    // positioned-предка. Второй под корневым transform раздувается вместе с
    // документом: на abs2.html маска росла 1280x800 -> 2103x1315 и уезжала в
    // -411,-257. Тот же закон zoom=1/S возвращает её на место (замерено: 0 px).
    function isViewportPositioned(el, cs) {
        if (cs.position === 'fixed') return true;
        if (cs.position !== 'absolute') return false;
        if (el === document.body || el === document.documentElement) return false;
        const op = el.offsetParent;
        return op === null || (op === document.body && bodyIsStatic());
    }

    // ---- Сбор кандидатов ----
    // Элемент внутри уже сконвертированного fixed-предка получает zoom: 1,
    // а не 1/S: кадр уже контр-масштабирован предком, второй zoom дал бы
    // двойное сжатие (диалог в shadow root внутри #popup-container уезжал
    // на -328, -234; с zoom=1 и замером при снятом zoom предка — точно).
    function inConvertedContext(el) {
        if (!converted) return null;
        let p = parentAcross(el);
        while (p && p !== document.documentElement && p !== document.body) {
            if (converted.has(p)) return p;
            p = parentAcross(p);
        }
        return null;
    }

    function considerNode(el, out) {
        if (!el || el.nodeType !== 1) return;
        if (converted && converted.has(el)) return;
        if (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
        let cs;
        try { cs = getComputedStyle(el); } catch (e) { return; }
        if (!cs || !isViewportPositioned(el, cs)) return;
        if (inTransformedContext(el)) return;
        const nestedIn = inConvertedContext(el);
        // Скрытое поддерево: бокса нет, не трогаем — иначе зафиксируем 0x0.
        // Появление поймает наблюдатель (class/style/hidden) пока идёт зум.
        let rect;
        try { rect = el.getBoundingClientRect(); } catch (e) { return; }
        if (!rect.width && !rect.height) return;
        const l = parseFloat(cs.left), t = parseFloat(cs.top);
        if (!isFinite(l) || !isFinite(t)) return;
        // converted помечаем сразу при чтении: walk идёт в порядке документа,
        // и вложенный fixed-потомок должен видеть предка уже сконвертированным
        // (замерено на ytlike.html: без этого диалог получал второй zoom).
        if (converted) converted.add(el);
        out.push({
            el: el,
            style: grabStyle(el, FIXED_PROPS),
            bx: l + (parseFloat(cs.marginLeft) || 0),
            by: t + (parseFloat(cs.marginTop) || 0),
            w: el.offsetWidth || rect.width,
            h: el.offsetHeight || rect.height,
            nested: !!nestedIn,
        });
    }

    function walkTree(node, out, depth) {
        if (!node || !node.isConnected) return;
        considerNode(node, out);
        // getElementsByTagName не видит shadow root: там живут fixed-шапки и
        // тосты веб-компонентов, и без обхода они уезжали вместе со страницей.
        if (depth < 6) walkShadow(node, out, depth);
        let nodes;
        try { nodes = node.querySelectorAll('*'); } catch (e) { return; }
        for (let i = 0, n = nodes.length; i < n; i++) {
            const el = nodes[i];
            considerNode(el, out);
            if (depth < 6) walkShadow(el, out, depth);
        }
    }

    function walkShadow(host, out, depth) {
        let sr;
        try { sr = host.shadowRoot; } catch (e) { return; }
        if (!sr) return;   // закрытый shadow root недоступен никакому скрипту
        walkTree(sr, out, depth + 1);
    }

    // ---- Применение закона ----
    // Пишется один раз при сборе (позиция при S=1 — визуально ничего не
    // меняется) и затем каждый кадр в repoFixed(). Полный масштаб от бокса до
    // экрана равен 1 (zoom=1/S у верхнеуровневого, zoom=1 у вложенного),
    // поэтому собственный transform элемента даёт ровно тот же экранный
    // сдвиг, что на масштабе 1, и трогать его не нужно.
    function applyRecord(r) {
        const el = r.el;
        setImp(el, 'margin', '0');
        setImp(el, 'box-sizing', 'border-box');
        setImp(el, 'width', r.w + 'px');
        setImp(el, 'height', r.h + 'px');
        setImp(el, 'zoom', r.nested ? '1' : String(1 / curScale));
        setImp(el, 'left', (r.bx - curTx) + 'px');
        setImp(el, 'top', (r.by - curTy) + 'px');
        r.s = curScale; r.x = curTx; r.y = curTy;
    }

    function repoFixed() {
        const n = fixed.length;
        if (!n) return;
        const S = curScale, tx = curTx, ty = curTy;
        const z = String(1 / S);
        for (let i = 0; i < n; i++) {
            const r = fixed[i];
            if (!r || !r.el || !r.el.isConnected) continue;
            try {
                if (r.nested) {
                    if (r.s !== 1) { setImp(r.el, 'zoom', '1'); r.s = 1; }
                } else if (r.s !== S) { setImp(r.el, 'zoom', z); r.s = S; }
                if (r.x !== tx) { setImp(r.el, 'left', (r.bx - tx) + 'px'); r.x = tx; }
                if (r.y !== ty) { setImp(r.el, 'top', (r.by - ty) + 'px'); r.y = ty; }
            } catch (e) {}
        }
    }

    // Принудительный возврат zoom после замера: r.s уже мог быть равен S,
    // поэтому тихое сравнение в repoFixed() пропустило бы запись.
    function repoFixedForceZoom() {
        for (let i = 0; i < fixed.length; i++) {
            const r = fixed[i];
            if (!r || !r.el || !r.el.isConnected) continue;
            try {
                setImp(r.el, 'zoom', r.nested ? '1' : String(1 / curScale));
                r.s = curScale;
            } catch (e) {}
        }
    }

    // scope задан → полный скан поддерева; scope === null → только новые узлы,
    // накопленные наблюдателем за прошедший кадр.
    function collectFixed(scope) {
        const q = [];
        if (scope) {
            q.push(scope);
        } else {
            for (let i = 0; i < pendingScan.length; i++) q.push(pendingScan[i]);
        }
        pendingScan.length = 0;
        scanAll = false;
        if (!q.length) return;

        // Замер идёт при СНЯТЫХ transform и will-change у <html> и снятом zoom
        // у сконвертированных элементов — каждый из них делает <html>
        // containing block для fixed-потомков и искажает процентные цели:
        // top:50% читался как 1134.25 вместо 450 (complex.html), late-тост
        // bottom:80px вставал на 1898 вместо 720 (will-change), диалог в
        // shadow root читал left 1039.32 вместо 640.5 (zoom предка, mech3).
        // Всё происходит в одной задаче до отрисовки — кадр этого не видит.
        const wasActive = active && curScale > 1.0001;
        if (wasActive) {
            try {
                getRoot().style.setProperty('transform', 'none', 'important');
                getRoot().style.setProperty('will-change', 'auto', 'important');
            } catch (e) {}
            for (let i = 0; i < fixed.length; i++) {
                const r = fixed[i];
                if (r && r.el && !r.nested) {
                    try { r.el.style.setProperty('zoom', '1', 'important'); } catch (e) {}
                }
            }
        }
        const out = [];
        try {
            // Сначала только чтение (getComputedStyle + rect), потом только
            // запись: иначе каждая запись вызывала бы пересчёт стилей.
            for (let i = 0; i < q.length; i++) walkTree(q[i], out, 0);
        } finally {
            if (wasActive) {
                try {
                    writeRoot();
                    setImp(getRoot(), 'will-change', 'transform');
                } catch (e) {}
                repoFixedForceZoom();
            }
        }
        if (!out.length) return;
        for (let i = 0; i < out.length; i++) {
            fixed.push(out[i]);
        }
        for (let i = 0; i < out.length; i++) {
            try { applyRecord(out[i]); } catch (e) {}
        }
    }

    function restoreFixed() {
        for (let i = fixed.length - 1; i >= 0; i--) {
            const r = fixed[i];
            if (!r || !r.el) continue;
            try { putStyle(r.el, r.style); } catch (e) {}
        }
        fixed = [];
        converted = typeof WeakSet === 'function' ? new WeakSet() : null;
    }

    // ----- Кадр -----------------------------------------------------------
    function writeRoot() {
        const el = getRoot();
        if (!el) return;
        try {
            el.style.setProperty('transform',
                'translate(' + curTx + 'px, ' + curTy + 'px) scale(' + curScale + ')',
                'important');
        } catch (e) {}
    }

    function frame(ts) {
        rafId = 0;
        if (!active) return;
        if (!lastTs) lastTs = ts;
        const dt = Math.min(80, Math.max(4, ts - lastTs));
        lastTs = ts;

        if (scanAll) {
            collectFixed(document.body || getRoot());
        } else if (pendingScan.length) {
            collectFixed(null);
        }

        const k = 1 - Math.exp(-dt / TAU);
        curScale += (tgtScale - curScale) * k;
        curTx += (tgtTx - curTx) * k;
        curTy += (tgtTy - curTy) * k;

        const doneS = Math.abs(tgtScale - curScale) <= 1e-5 * Math.max(1, tgtScale);
        const doneT = Math.abs(tgtTx - curTx) <= 0.02 && Math.abs(tgtTy - curTy) <= 0.02;
        if (doneS) curScale = tgtScale;
        if (doneT) { curTx = tgtTx; curTy = tgtTy; }

        writeRoot();
        repoFixed();

        if (doneS && doneT) {
            settle();
        } else {
            rafId = requestAnimationFrame(frame);
        }
    }

    function kick() {
        if (!active) return;
        if (rafId) return;
        lastTs = 0;
        if (!willChangeOn) {
            willChangeOn = true;
            try { setImp(getRoot(), 'will-change', 'transform'); } catch (e) {}
        }
        rafId = requestAnimationFrame(frame);
    }

    // Движение закончилось: снимаем will-change, чтобы браузер перерисовал
    // страницу чётко (в покое слои = замыливание). Никакого таймера не нужно:
    // цикл кадров сам останавливается здесь же.
    function settle() {
        if (willChangeOn) {
            willChangeOn = false;
            try { getRoot().style.removeProperty('will-change'); } catch (e) {}
        }
        if (curScale <= 1.0001) exitToNative();
    }

    // ----- Вход/выход -----------------------------------------------------
    function docIsClean(el) {
        let cs;
        try { cs = getComputedStyle(el); } catch (e) { return true; }
        if (!cs) return true;
        if (cs.transform && cs.transform !== 'none') return false;
        if (cs.zoom && cs.zoom !== 'normal' && cs.zoom !== '1') {
            const n = parseFloat(cs.zoom);
            if (isFinite(n) && n > 0 && Math.abs(n - 1) > 0.001) return false;
        }
        return true;
    }

    function enterZoom() {
        if (active) return false;
        const el = getRoot();
        if (!el) return false;
        // Страницу со своим transform/zoom на <html> не трогаем: наш transform
        // перезаписал бы их и зум поехал бы не от курсора.
        if (!docIsClean(el)) return false;

        savedRoot = grabStyle(el, ROOT_PROPS);

        // Прокрутку забираем себе: translate заменяет scrollX/scrollY — как в
        // 2.7.0: tx = -scrollX, затем scrollTo(0,0). Вид не меняется, а вся
        // панорамная арифметика остаётся в координатах scroll=0.
        // Порядок важен — сначала читаем прокрутку и блокируем скролл, потом
        // меряем, иначе viewW запомнится вместе с полосой прокрутки (1265
        // вместо 1280) и привязка к курсору сместится на половину её ширины.
        const sx = window.scrollX || 0, sy = window.scrollY || 0;
        try { window.scrollTo(0, 0); } catch (e) {}
        // Полоса прокрутки при overflow:hidden исчезнет и страница станет шире
        // на её ширину. scrollbar-gutter:stable оставляет место зарезервированным,
        // поэтому геометрия не меняется вовсе (замерено: без него привязка
        // уезжала на 7.5 px за первый шаг).
        try {
            if ((window.innerWidth || 0) - (el.clientWidth || 0) > 0) setImp(el, 'scrollbar-gutter', 'stable');
            setImp(el, 'overflow', 'hidden');
        } catch (e) {}

        curScale = tgtScale = 1;
        curTx = tgtTx = -sx;
        curTy = tgtTy = -sy;
        measure();
        if (baseW < viewW + sx) baseW = viewW + sx;
        if (baseH < viewH + sy) baseH = viewH + sy;

        // ВАЖНО: fixed-слой снимается ДО записи transform на <html>:
        // трансформированный <html> становится containing block для fixed
        // потомков, и top:50% считался от документа (1134.25 вместо 450 на
        // complex.html). Поздний сбор снимает transform сам — collectFixed.
        try { collectFixed(document.body || el); } catch (e) {}

        try {
            setImp(el, 'transform-origin', '0 0');
            setImp(el, 'transition', 'none');
            setImp(el, 'will-change', 'transform');
            willChangeOn = true;
            writeRoot();
        } catch (e) {}

        active = true;
        bindSession();
        return true;
    }

    function exitToNative() {
        if (!active) {
            detachWheel();
            return;
        }
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        active = false;
        willChangeOn = false;
        unbindSession();

        // Нативный скролл туда, где видна та же картинка: scroll = -translate/S.
        const backX = curScale > 0 ? -curTx / curScale : -curTx;
        const backY = curScale > 0 ? -curTy / curScale : -curTy;

        try { restoreFixed(); } catch (e) {}
        const el = getRoot();
        if (savedRoot && el) putStyle(el, savedRoot);
        savedRoot = null;

        try { window.scrollTo(backX, backY); } catch (e) {}
        curScale = tgtScale = 1;
        curTx = tgtTx = 0;
        curTy = tgtTy = 0;
        lastTs = 0;
        detachWheel();
    }

    // ----- Наблюдение за DOM (только пока идёт зум) -----------------------
    // Нужен, чтобы диалог/тост, созданный во время зума, получил закон в том
    // же кадре, а не уехал вместе с документом. В простое наблюдателей нет.
    function onMutations(records) {
        if (!active) return;
        let any = false;
        for (let i = 0; i < records.length; i++) {
            const rec = records[i];
            if (rec.type === 'attributes') {
                const t = rec.target;
                if (!t || t === getRoot() || t === document.body) continue;
                if (converted && converted.has(t)) continue;
                pendingScan.push(t);
                any = true;
                continue;
            }
            const add = rec.addedNodes;
            for (let j = 0; j < add.length; j++) {
                const n = add[j];
                if (!n || n.nodeType !== 1) continue;
                if (pendingScan.length > 300) { scanAll = true; break; }
                pendingScan.push(n);
                any = true;
            }
        }
        if (any) kick();
    }

    function observeShadows(scope) {
        if (typeof MutationObserver !== 'function' || !shadowSeen) return;
        let nodes;
        try { nodes = scope.querySelectorAll('*'); } catch (e) { return; }
        for (let i = 0, n = nodes.length; i < n; i++) {
            const e = nodes[i];
            let sr;
            try { sr = e.shadowRoot; } catch (err) { sr = null; }
            if (!sr || shadowSeen.has(sr)) continue;
            shadowSeen.add(sr);
            try {
                const mo = new MutationObserver(onMutations);
                mo.observe(sr, {
                    childList: true, subtree: true,
                    attributes: true, attributeFilter: ['class', 'style', 'hidden'],
                });
                shadowObservers.push(mo);
            } catch (err) {}
            observeShadows(sr);
        }
    }

    function onScrollLock() {
        if (!active) return;
        if (!window.scrollX && !window.scrollY) return;
        try { window.scrollTo(0, 0); } catch (e) {}
    }

    function onResize() {
        if (!active) return;
        measure();
        clampPan();
        kick();
    }

    function bindSession() {
        window.addEventListener('resize', onResize, { passive: true });
        window.addEventListener('scroll', onScrollLock, { passive: true });
        if (typeof MutationObserver !== 'function' || !document.body) return;
        try {
            observer = new MutationObserver(onMutations);
            observer.observe(document.body, {
                childList: true, subtree: true,
                attributes: true, attributeFilter: ['class', 'style', 'hidden'],
            });
        } catch (e) { observer = null; }
        observeShadows(document.body);
    }

    function unbindSession() {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('scroll', onScrollLock);
        if (observer) {
            try { observer.disconnect(); } catch (e) {}
            observer = null;
        }
        for (let i = 0; i < shadowObservers.length; i++) {
            try { shadowObservers[i].disconnect(); } catch (e) {}
        }
        shadowObservers = [];
        shadowSeen = typeof WeakSet === 'function' ? new WeakSet() : null;
        pendingScan.length = 0;
        scanAll = false;
    }

    // ----- Ввод -----------------------------------------------------------
    // Непассивный wheel-обработчик на window заставляет Chrome ждать главный
    // поток перед каждой нативной прокруткой, поэтому в простое висит только
    // ПАССИВНЫЙ разведчик: он ничего не отменяет и на скролл не влияет.
    // Увидев ctrlKey (Ctrl+колесо или pinch тачпада), он в том же событии
    // подключает рабочий обработчик на document (capture). Проверено
    // (scout.mjs): обработчик успевает получить то же событие — первое в
    // цепочке cancelable=false, дальше true. Реальный пользователь обычно
    // зажимает Ctrl до колеса — тогда keydown подключает обработчик раньше.
    let ctrlHeld = false;
    let wheelAttached = false;
    const wheelOpts = { passive: false, capture: true };

    function onWheel(e) {
        try {
            if (e.ctrlKey) {
                e.preventDefault();
                e.stopPropagation();
                let dy = e.deltaY;
                if (e.deltaMode === 1) dy *= 16;
                else if (e.deltaMode === 2) dy *= 100;
                // На норме крутят «от себя»: гасим событие, но НЕ входим в
                // зум. Проверка ДО enterZoom: иначе очередной «от себя» после
                // выхода снова входил в зум и оставлял страницу в режиме
                // scale=1 (замерено на szv16: transform matrix(1,0,0,1,0,0)
                // после выхода, will-change и overflow не сняты).
                if (!active && dy >= 0) return;
                if (!active && !enterZoom()) return;
                // У нижней границы и крутят «от себя»: работы нет.
                if (tgtScale <= 1.0001 && dy > 0) return;
                // Считаем от цели, а не от записанного: несколько событий за                // кадр складываются правильно, и точка остаётся под курсором.
                const lx = (e.clientX - tgtTx) / tgtScale;
                const ly = (e.clientY - tgtTy) / tgtScale;
                let k = 1 - dy * CONFIG.wheelStep;
                if (!(k > 0.15)) k = 0.15;
                else if (k > 4) k = 4;
                let next = clampScale(tgtScale * k);
                if (next <= 1.0001) next = CONFIG.minScale;
                tgtScale = next;
                tgtTx = e.clientX - lx * tgtScale;
                tgtTy = e.clientY - ly * tgtScale;
                clampPan();
                kick();
                return;
            }
            if (!active) return;
            // Прокрутка по увеличенной странице: 1:1, без сглаживания.
            if (curScale <= 1.0001) { exitToNative(); return; }
            e.preventDefault();
            e.stopPropagation();
            let dx = e.deltaX, dy = e.deltaY;
            if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
            else if (e.deltaMode === 2) { dx *= viewW || 800; dy *= viewH || 600; }
            if ((e.shiftKey && CONFIG.shiftWheelHorizontal) ||
                (e.shiftKey && Math.abs(dx) < 0.0001)) {
                tgtTx -= dy * CONFIG.panSpeed;
            } else {
                tgtTx -= dx * CONFIG.panSpeed;
                tgtTy -= dy * CONFIG.panSpeed;
            }
            clampPan();
            curTx = tgtTx;
            curTy = tgtTy;
            kick();
        } catch (err) {}
    }

    // Пассивный разведчик. На обычный скролл работы ноль: одна проверка ctrlKey.
    function scout(e) {
        if (e.ctrlKey) attachWheel();
    }

    function attachWheel() {
        if (wheelAttached) return;
        try {
            document.addEventListener('wheel', onWheel, wheelOpts);
            wheelAttached = true;
        } catch (e) {}
    }

    function detachWheel() {
        if (!wheelAttached || ctrlHeld || active) return;
        try { document.removeEventListener('wheel', onWheel, wheelOpts); } catch (e) {}
        wheelAttached = false;
    }

    window.addEventListener('wheel', scout, { passive: true, capture: true });

    window.addEventListener('keydown', function (e) {
        if (e.ctrlKey || e.key === 'Control') {
            ctrlHeld = true;
            attachWheel();
        }
    }, { passive: true });

    window.addEventListener('keyup', function (e) {
        if (!e.ctrlKey || e.key === 'Control') {
            ctrlHeld = false;
            detachWheel();
        }
    }, { passive: true });

    window.addEventListener('blur', function () {
        ctrlHeld = false;
        if (active) exitToNative();
        else detachWheel();
    });

    window.addEventListener('pagehide', function () {
        if (active) exitToNative();
    }, { passive: true });
})();
