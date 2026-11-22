// ==UserScript==
// @name         Smooth Zoom to Cursor
// @namespace    https://github.com/diple-df/Smooth-Zoom
// @version      2.14.0
// @description  Trackpad-style smooth zoom to the cursor (Ctrl+Wheel). Compositor-driven CSS transition, at most one transform write per frame, zero work while idle. Crisp at rest, keeps fixed elements. Native Ctrl +/- left intact. Configurable via menu.
// @description:ru Плавный зум к курсору (Ctrl+колесо). Анимация на композиторе, не больше одной записи transform за кадр, в простое скрипт не делает ничего. Чётко в покое, fixed не пропадают. Родной зум Ctrl +/- не трогается. Настраивается через меню.
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

(function () {
    'use strict';

    const HTML_NS = 'http://www.w3.org/1999/xhtml';
    // Свойства, которые скрипт трогает у <html> и у конвертированных fixed-элементов.
    const ROOT_PROPS = ['transform', 'transform-origin', 'will-change', 'transition', 'zoom', 'overflow', 'scrollbar-gutter'];
    const FIXED_PROPS = ['position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'margin', 'box-sizing', 'transform', 'transform-origin', 'scale', 'zoom'];
    // Контр-масштаб пишем отдельным свойством scale, а не transform: у многих
    // элементов (центрирование translate(-50%,-50%), собственный scale,
    // CSS-анимация вращения) transform занят, и перезапись уносила их с экрана.
    const CAN_SCALE_PROP = (function () {
        try {
            return typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('scale', '0.5');
        } catch (e) { return false; }
    })();

    // ----- Настройки -----------------------------------------------------
    const DEFAULT_CFG = {
        minScale: 1,
        maxScale: 10,
        wheelStep: 0.0015,
        panSpeed: 1,
        transitionMs: 120,
        crispDelayMs: 200,
        shiftWheelHorizontal: false,
    };
    let CONFIG = Object.assign({}, DEFAULT_CFG);
    try {
        if (typeof GM_getValue === 'function') {
            const s = GM_getValue('smoothzoom_cfg', null);
            if (s) CONFIG = Object.assign({}, DEFAULT_CFG, JSON.parse(s));
        }
    } catch(e) {}

    function saveCfg(){
        try {
            if (typeof GM_setValue === 'function') GM_setValue('smoothzoom_cfg', JSON.stringify(CONFIG));
        } catch(e){}
    }

    // ----- Автообновление -------------------------------------------------
    // Пассивная часть — @updateURL/@downloadURL в шапке: Tampermonkey сам
    // сверяет версию. Здесь активная: проверка по запросу из меню и раз в
    // сутки фоном, с баннером «доступна новая версия».
    // Скрипт висит на *://*/*, поэтому проверка обязана быть почти бесплатной:
    // на старте читается один timestamp, сеть трогается не чаще раза в сутки
    // и только после загрузки страницы.
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
            return '2.10.0';
        }

        // Сравнение по числовым сегментам: 2.10.0 больше 2.10.0 (строкой — нет).
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
            // Без своего UI: короткий тост тем же баннером.
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
    }

    try {
        if (document.readyState === 'complete') UPDATE.maybeAuto();
        else window.addEventListener('load', UPDATE.maybeAuto, { once: true, passive: true });
    } catch (e) {}

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Smooth Zoom: Сбросить настройки', function(){
            CONFIG = Object.assign({}, DEFAULT_CFG);
            saveCfg();
            location.reload();
        });
    }

    // ----- Состояние -----------------------------------------------------
    // Модель: viewport = origin + translate + scale * local,
    // где local — координаты внутри border-box <html> при scroll 0,
    // origin — левый верхний угол этого border-box в окне при scroll 0.
    // Масштаб ведёт CSS transition на композиторе; главный поток пишет
    // не больше одного transform за кадр и полностью замолкает в покое.
    let scale = 1;                 // текущий/целевой масштаб (1 = норма)
    let tx = 0, ty = 0;            // CSS translate в px (ровно то, что пишем)
    let originX = 0, originY = 0;  // border-box <html> при scroll 0 (без transform)
    let transformActive = false;
    let root = null;
    let savedRoot = null;          // inline-стили <html> до зума
    let savedScrollBehavior = null;
    let savedFixed = [];           // [{ el, style: [[prop, value, priority], ...] }]
    let converted = new WeakSet(); // уже сконвертированные элементы (не перечитываем стили)
    // Позиция fixed-элемента в координатах вьюпорта на масштабе 1. Нужна,
    // чтобы пересчитывать его при каждой смене зума: без этого шапка и
    // модальные окна уезжали за экран вместе с масштабом.
    let captureNatural = true;     // true на входе: rect ещё не искажён transform'ом
    let lastRepoS = -1, lastRepoTx = 0, lastRepoTy = 0;
    let savedBodyOverflow = null;
    let calibratedAt = 0;          // масштаб, на котором уже калибровали fixed
    let willChangeOn = false;
    let animOn = false;            // на <html> сейчас стоит анимирующий transition
    let frameHandle = 0;
    let lastWriteTs = 0;
    let crispTimer = null, exitTimer = null;
    // Кэш размеров — чтобы не читать layout в обработчиках ввода.
    let viewW = 0, viewH = 0, baseW = 0, baseH = 0;
    let minTx = 0, minTy = 0, maxTx = 0, maxTy = 0;
    // Состояние, в котором реально измеряем элементы: во время анимации оно
    // отличается от цели, поэтому читаем матрицу один раз на скан.
    let convS = 1, convTx = 0, convTy = 0;
    let geoDirty = true;
    let docCheckAt = 0, docOk = true;

    function getRoot() {
        if (!root || !root.isConnected) {
            root = document.documentElement;
        }
        return root;
    }

    function clampScale(s) {
        return Math.min(CONFIG.maxScale, Math.max(CONFIG.minScale, s));
    }

    // ----- Работа с inline-стилями (сохранить/восстановить без порчи) -----
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
            } catch (e) {
                // пропускаем
            }
        }
    }

    function setImp(el, prop, value) {
        el.style.setProperty(prop, value, 'important');
    }

    // ----- Замеры (только на входе, при ресайзе и при изменениях DOM) -----
    function measure() {
        const el = getRoot();
        viewW = (el && el.clientWidth) || window.innerWidth || 0;
        viewH = (el && el.clientHeight) || window.innerHeight || 0;
        baseW = Math.max((el && el.scrollWidth) || 0, viewW);
        baseH = Math.max((el && el.scrollHeight) || 0, viewH);
    }

    function getSearchRoot() {
        if (document.body) return document.body;
        if (document.documentElement) return document.documentElement;
        return null;
    }

    // ----- Границы панорамы (только арифметика, без layout) ----------------
    // translate играет роль -scrollX: как и нативный скролл, диапазон
    // [-(SW*scale - VW), 0]. originX сюда не входит — он лишь сдвигает
    // начало координат, но не увеличивает прокручиваемую область.
    function updateBounds() {
        maxTx = 0;
        maxTy = 0;
        minTx = viewW - baseW * scale;
        minTy = viewH - baseH * scale;
        if (minTx > maxTx) minTx = maxTx;
        if (minTy > maxTy) minTy = maxTy;
    }

    function clampPan() {
        if (viewW <= 0 || viewH <= 0 || baseW <= 0 || baseH <= 0) measure();
        updateBounds();
        if (tx > maxTx) tx = maxTx;
        else if (tx < minTx) tx = minTx;
        if (ty > maxTy) ty = maxTy;
        else if (ty < minTy) ty = minTy;
    }

    // Текущая матрица на <html>: масштаб и translate так, как их видит браузер
    // прямо сейчас (середина анимации тоже). Нужна только на скан DOM.
    // На входе в зум матрицы ещё нет — тогда работает пара (scale, tx/ty),
    // которая в этот момент эквивалентна прежнему нативному скроллу.
    function syncConv() {
        convS = scale;
        convTx = tx;
        convTy = ty;
        let m;
        try {
            m = getComputedStyle(getRoot()).transform;
        } catch (e) {
            return;
        }
        if (!m || m === 'none') return;
        try {
            if (m.indexOf('matrix3d') === 0) {
                const p = m.slice(9, -1).split(',');
                const s = parseFloat(p[0]), x = parseFloat(p[12]), y = parseFloat(p[13]);
                if (isFinite(s) && s > 0) convS = s;
                if (isFinite(x)) convTx = x;
                if (isFinite(y)) convTy = y;
            } else if (m.indexOf('matrix') === 0) {
                const p = m.slice(7, -1).split(',');
                const s = parseFloat(p[0]), x = parseFloat(p[4]), y = parseFloat(p[5]);
                if (isFinite(s) && s > 0) convS = s;
                if (isFinite(x)) convTx = x;
                if (isFinite(y)) convTy = y;
            }
        } catch (e) {
            // оставляем значения по умолчанию
        }
    }

    // ----- fixed -> absolute ---------------------------------------------
    // Один проход чтения (getComputedStyle + rect + box-sizing), затем проход
    // записи. Иначе каждая запись вызывала бы новый style/layout пересчёт.
    function considerNode(el, out) {
        if (converted.has(el)) return;
        // Сами себя не конвертируем и вложенные fixed не трогаем: у них уже
        // другой offsetParent, и absolute сломал бы их привязку.
        let p = el.parentElement;
        while (p) {
            if (converted.has(p)) return;
            p = p.parentElement;
        }
        let cs;
        try {
            cs = getComputedStyle(el);
        } catch (e) {
            return;
        }
        if (!cs || cs.position !== 'fixed') return;
        // Содержащий блок не вьюпорт — элемент уже живёт в своём контексте
        // и масштабируется вместе с ним. Замерено: попытка компенсировать
        // такой узел давала промах до 784 px по вертикали.
        if (hasTransformAncestor(el)) return;
        // position: sticky сознательно не конвертируем: absolute вырвал бы
        // элемент из потока, и контент под ним прыгнул бы вверх. Sticky сам
        // держится своей позиции в потоке, а скролл у нас всё равно 0.
        let rect;
        try {
            rect = el.getBoundingClientRect();
        } catch (e) {
            return;
        }
        // Скрытое поддерево (display:none): бокса нет. Не трогаем, иначе
        // получили бы 0x0 и сломали элемент, когда его покажут. Если он
        // появится позже, это поймает наблюдатель (класс/скрытость).
        if (!rect.width && !rect.height) return;
        // transform-origin в px от левого верхнего угла border-box.
        const toks = String(cs.transformOrigin || '').split(' ');
        let tox = parseFloat(toks[0]), toy = parseFloat(toks[1]);
        if (!isFinite(tox)) tox = 0;
        if (!isFinite(toy)) toy = 0;
        // Вклад СОБСТВЕННОГО transform элемента в его экранную позицию.
        // Считается как разница между фактическим боксом и layout-позицией из
        // computed left/top: для translate(-50%,-50%) это ровно -150,-80,
        // для scale(.9) с origin center — половина разницы размеров.
        // Без этой величины элемент с центрированием уезжает на её значение,
        // потому что zoom не масштабирует собственный transform элемента.
        const cl = parseFloat(cs.left), ct = parseFloat(cs.top);
        const mx = isFinite(cl) ? rect.left - cl : 0;
        const my = isFinite(ct) ? rect.top - ct : 0;
        // Переводим в local-координаты: (viewport - origin - translate) / scale.
        const inv = convS > 0 ? 1 / convS : 1;
        // Размер для записи. rect точен, но искажается transform'ом (своим или
        // предка) и zoom'ом. offsetWidth/offsetHeight — это layout border-box,
        // преобразования на них не влияют, поэтому используем их как сверку:
        // если rect с ними не сходится, берём их (с точностью до пикселя).
        const bw = rect.width * inv;
        const bh = rect.height * inv;
        let w = bw, h = bh;
        const ow = el.offsetWidth, oh = el.offsetHeight;
        if (ow > 0 && oh > 0 &&
            (Math.abs(ow - bw) > 1.5 || Math.abs(oh - bh) > 1.5)) {
            w = ow;
            h = oh;
        }
        out.push({
            el: el,
            rect: rect,
            tox: tox,
            toy: toy,
            mx: mx,
            my: my,
            left: (rect.left - originX - convTx) * inv,
            top: (rect.top - originY - convTy) * inv,
            w: w,
            h: h,
            borderBox: cs.boxSizing === 'border-box',
            pl: parseFloat(cs.paddingLeft) || 0,
            pr: parseFloat(cs.paddingRight) || 0,
            pt: parseFloat(cs.paddingTop) || 0,
            pb: parseFloat(cs.paddingBottom) || 0,
            bl: parseFloat(cs.borderLeftWidth) || 0,
            br: parseFloat(cs.borderRightWidth) || 0,
            bt: parseFloat(cs.borderTopWidth) || 0,
            bb: parseFloat(cs.borderBottomWidth) || 0
        });
    }

    // position:fixed внутри предка с transform/filter/contain/will-change уже
    // НЕ привязан к вьюпорту: его содержащий блок — этот предок. Скрипт считает
    // left/top от вьюпорта, поэтому такой элемент уезжал на сотни пикселей
    // (замерено: -195 px по X на тестовой странице). Такие узлы не трогаем —
    // они корректно масштабируются вместе со своим контейнером.
    function hasTransformAncestor(el) {
        let p = el.parentElement;
        while (p && p !== document.documentElement && p !== document.body) {
            let cs2;
            try { cs2 = getComputedStyle(p); } catch (e) { return true; }
            if (!cs2) return true;
            if (cs2.transform && cs2.transform !== 'none') return true;
            if (cs2.filter && cs2.filter !== 'none') return true;
            if (cs2.backdropFilter && cs2.backdropFilter !== 'none') return true;
            if (cs2.perspective && cs2.perspective !== 'none') return true;
            if (cs2.contain && /paint|layout|strict|content/i.test(cs2.contain)) return true;
            if (cs2.willChange && /transform|perspective|filter/i.test(cs2.willChange)) return true;
            p = p.parentElement;
        }
        return false;
    }

    // Обход одного дерева. shadowDepth ограничивает вложенность, чтобы
    // патологическая страница не зациклила нас на собственных пересозданиях.
    function collectTree(root, out, shadowDepth) {
        if (!root || !root.isConnected) return;
        if (root.nodeType === 1 && (!root.namespaceURI || root.namespaceURI === HTML_NS)) {
            considerNode(root, out);
            if (shadowDepth < 6) collectShadow(root, out, shadowDepth);
        }
        // querySelectorAll, а не getElementsByTagName: у ShadowRoot
        // последнего нет, и обход молча обрывался на первом же компоненте.
        let nodes;
        try {
            nodes = root.querySelectorAll('*');
        } catch (e) {
            return;
        }
        for (let i = 0, len = nodes.length; i < len; i++) {
            const el = nodes[i];
            // SVG/MathML не бывают fixed — не тратим на них getComputedStyle.
            if (el.namespaceURI && el.namespaceURI !== HTML_NS) continue;
            considerNode(el, out);
            if (shadowDepth < 6) collectShadow(el, out, shadowDepth);
        }
    }

    // getElementsByTagName не видит содержимое shadow root: веб-компоненты
    // держат там свои fixed-шапки и тосты. Без этого прохода они просто
    // уезжали вместе со страницей при зуме.
    function collectShadow(host, out, shadowDepth) {
        let sr;
        try { sr = host.shadowRoot; } catch (e) { return; }
        if (!sr) return; // закрытый shadow root недоступен — пропускаем
        collectTree(sr, out, shadowDepth + 1);
    }

    function collectFixed(scope, out) {
        collectTree(scope, out, 0);
    }

    const foundItems = [];

    function applyFixed(items) {
        const n = items.length;
        if (!n) return;
        // Появились новые элементы — кэш «уже пересчитано» недействителен,
        // иначе repoFixed() не поставит им компенсацию при том же зуме.
        lastRepoS = -1;
        // position остаётся fixed: измерено, что fixed не подчиняется transform
        // предка, но подчиняется zoom, поэтому именно zoom даёт точный
        // контр-масштаб. Собственный transform элемента (translate(-50%,-50%),
        // scale, rotate, анимации) при этом не перезаписывается — это и был
        // корень бага «элементы прилетают мимо экрана».
        for (let i = 0; i < n; i++) {
            const f = items[i];
            const el = f.el;
            if (!el) continue;
            try {
                const rec = {
                    el: el,
                    style: grabStyle(el, FIXED_PROPS),
                    // Экранная позиция на масштабе 1 — цель, к которой элемент
                    // обязан вернуться после любого зума.
                    //
                    // ВАЖНО: берём её из local-координат (f.left/f.top), а не
                    // из f.rect.left. Для элементов, которые были на странице
                    // при входе в зум, это одно и то же число. А элемент,
                    // ПОЯВИВШИЙСЯ уже во время зума (модалка, тост, меню),
                    // отдаёт rect, уже сдвинутый корневым transform: при
                    // масштабе 1.39 модалка уезжала на -251,-157 px, то есть
                    // целиком за экран. Это и есть «лишние элементы при зуме».
                    bx: f.left + originX,
                    by: f.top + originY,
                    // Вклад собственного transform элемента: посчитан в
                    // considerNode() как rect.left - computed left. Оба числа
                    // уже прочитаны, поэтому лишнего reflow нет.
                    mx: f.mx || 0,
                    my: f.my || 0,
                    w: f.w,
                    h: f.h
                };
                savedFixed.push(rec);
                f.rec = rec;
                converted.add(el);
                // right/bottom привязки снимаем: иначе элемент, закреплённый
                // справа, будет расти влево и уползёт.
                setImp(el, 'right', 'auto');
                setImp(el, 'bottom', 'auto');
                setImp(el, 'margin', '0');
                // Ширину и высоту фиксируем в тех px, что были: процентные и
                // calc() размеры считаются от изменившегося контейнера.
                // Ширину фиксируем ВСЕГДА: right снят, значит ширину больше
                // ничто не задаёт, и auto схлопнул бы элемент по содержимому
                // (замерено: шапка 1265 -> 224 px). box-sizing переводим в
                // border-box, чтобы f.w (внешний размер) записался как есть.
                setImp(el, 'box-sizing', 'border-box');
                setImp(el, 'width', f.w + 'px');
                // Высоту — только когда она была задана явно: у auto-высоты
                // содержимое может вырасти и его нельзя обрезать.
                if (f.borderBox) setImp(el, 'height', f.h + 'px');
            } catch (e) {
                // пропускаем
            }
        }
        repoFixed();
    }

    // Пересчёт fixed-элементов при смене масштаба: каждый остаётся там же на
    // экране, где был на 100%, вместо того чтобы уезжать вместе с контентом.
    function repoFixed() {
        const n = savedFixed.length;
        if (!n) return;
        if (lastRepoS === scale && lastRepoTx === tx && lastRepoTy === ty) return;
        lastRepoS = scale;
        lastRepoTx = tx;
        lastRepoTy = ty;
        const S = scale;
        const k = S > 0 ? 1 / S : 1;
        // Экранная позиция fixed-элемента под корневым
        // translate3d(tx,ty,0) scale(S) равна  tx + S*left*zoom.
        // При zoom = 1/S это tx + left, поэтому left = цель - tx. Один и тот же
        // закон верен для обеих осей и не требует чтения layout в кадре:
        // всё нужное (bx/by — цель, mx/my — вклад собственного transform) уже
        // измерено при конвертации.
        // Элементы со своим transform центрируются от своего origin, и их
        // вклад не зависит от масштаба — отсюда постоянные mx/my.
        for (let i = 0; i < n; i++) {
            const r = savedFixed[i];
            if (!r || !r.el || !r.el.isConnected) continue;
            try {
                setImp(r.el, 'zoom', String(k));
                setImp(r.el, 'left', (r.bx - tx - (r.cx || 0)) + 'px');
                setImp(r.el, 'top', (r.by - ty - (r.cy || 0)) + 'px');
            } catch (e) {
                // пропускаем
            }
        }
    }

    // Остаток от собственного transform элемента (% -центрирование считает
    // проценты от уже сжатого зумом бокса) не выводится формулой без знания
    // внутренней арифметики браузера. Зато он практически не зависит от
    // масштаба (проверено на 1.2…3.0), поэтому калибруется ОДИН раз при входе
    // в зум и дальше применяется как константа. Так в кадре не остаётся ни
    // одного замера layout.
    function calibrateFixed() {
        const n = savedFixed.length;
        if (!n) return;
        for (let i = 0; i < n; i++) {
            const r = savedFixed[i];
            if (!r || !r.el || !r.el.isConnected) continue;
            if (!r.mx && !r.my) continue;
            for (let pass = 0; pass < 2; pass++) {
                let rect;
                try { rect = r.el.getBoundingClientRect(); } catch (e) { break; }
                const ex = r.bx - rect.left;
                const ey = r.by - rect.top;
                if (Math.abs(ex) < 0.2 && Math.abs(ey) < 0.2) break;
                r.cx = (r.cx || 0) - ex;
                r.cy = (r.cy || 0) - ey;
                try {
                    setImp(r.el, 'left', (r.bx - tx - r.cx) + 'px');
                    setImp(r.el, 'top', (r.by - ty - r.cy) + 'px');
                } catch (e) { break; }
            }
            // После калибровки вклад собственного transform уже учтён в cx/cy.
            r.mx = 0;
            r.my = 0;
        }
    }

    function convertFixedElements() {
        const searchRoot = getSearchRoot();
        if (!searchRoot) return;
        syncConv();
        foundItems.length = 0;
        collectFixed(searchRoot, foundItems);
        applyFixed(foundItems);
    }

    // Калибровка вызывается только при входе в зум (один раз за сессию зума),
    // поэтому её замеры не попадают в кадры анимации.
    function calibrateAllFixed() {
        calibrateFixed();
        lastRepoS = -1;
        repoFixed();
        calibrateFixed();
        lastRepoS = -1;
    }

    function restoreFixedElements() {
        for (let i = savedFixed.length - 1; i >= 0; i--) {
            const s = savedFixed[i];
            if (!s || !s.el) continue;
            putStyle(s.el, s.style);
        }
        savedFixed = [];
        converted = new WeakSet();
    }

    // ----- Запись transform ----------------------------------------------
    // !important: чужой CSS не должен перебить наш transform, иначе зум
    // молча не сработает, а скролл останется заблокированным.
    function writeTransform() {
        const el = getRoot();
        if (!el) return;
        lastWriteTs = performance.now();
        if (!willChangeOn) {
            willChangeOn = true;
            try { setImp(el, 'will-change', 'transform'); } catch (e) {}
        }
        try {
            el.style.setProperty('transform',
                'translate3d(' + tx.toFixed(2) + 'px, ' + ty.toFixed(2) + 'px, 0) scale(' +
                scale.toFixed(4) + ')', 'important');
        } catch (e) {
            // игнорируем ошибки стилей
        }
    }

    // Панорама должна идти 1:1, а зум — плавно. Переключаем transition только
    // при смене режима (не на каждом событии) и перед этим «замораживаем»
    // фактическую матрицу, иначе незавершённый переход дёрнется в цель.
    function freezeLive() {
        if (!animOn) return;
        // Свежая матрица: переключаемся на мгновенный режим ровно из видимой
        // точки, иначе незавершённый переход дёрнулся бы в прежнюю цель.
        syncConv();
        if (convS > 0) {
            scale = convS;
            tx = convTx;
            ty = convTy;
        }
        animOn = false;
        // transition:none и запись живой матрицы — в одном пересчёте стилей,
        // поэтому кадр не «прыгает» на прежнюю цель.
        try { setImp(getRoot(), 'transition', 'none'); } catch (e) {}
        writeTransform();
    }

    function setTransitionAnimated() {
        if (animOn) return;
        animOn = true;
        try {
            setImp(getRoot(), 'transition', 'transform ' + CONFIG.transitionMs + 'ms ease-out');
        } catch (e) {
            // игнорируем
        }
    }

    // ----- Таймеры «покой»: гасим will-change и выходим в нативное состояние
    function armCrisp() {
        if (crispTimer) return;
        crispTimer = setTimeout(onCrisp, CONFIG.crispDelayMs);
    }

    function onCrisp() {
        crispTimer = null;
        if (!transformActive) return;
        if (performance.now() - lastWriteTs < CONFIG.crispDelayMs) {
            armCrisp();
            return;
        }
        // Догоняем точность после того, как анимация остановилась: элементы с
        // собственным transform нельзя вычислить формулой, но пока масштаб не
        // меняется, один замер ничего не стоит и не попадает в кадр.
        if (!calibratedAt || calibratedAt !== scale) {
            calibratedAt = scale;
            try {
                calibrateFixed();
            } catch (e) {
                // игнорируем
            }
        }
        // Снимаем слой и даём браузеру перерисовать страницу чётко.
        if (willChangeOn) {
            willChangeOn = false;
            try {
                const el = getRoot();
                // Возвращаем то, что было у страницы (обычно — ничего).
                let prev = '';
                if (savedRoot) {
                    for (let i = 0; i < savedRoot.length; i++) {
                        if (savedRoot[i].p === 'will-change') { prev = savedRoot[i].v; break; }
                    }
                }
                if (prev) el.style.setProperty('will-change', prev);
                else el.style.removeProperty('will-change');
            } catch (e) {
                // игнорируем
            }
        }
    }

    function armExit() {
        if (exitTimer) return;
        exitTimer = setTimeout(onExit, CONFIG.transitionMs + 80);
    }

    function onExit() {
        exitTimer = null;
        if (!transformActive) return;
        const wait = CONFIG.transitionMs + 80;
        if (performance.now() - lastWriteTs < wait) {
            armExit();
            return;
        }
        if (scale <= 1.0001) exitToNative();
    }

    // ----- Кадр: одна запись transform ------------------------------------
    function scheduleFrame() {
        if (!frameHandle) frameHandle = requestAnimationFrame(commitFrame);
    }

    function commitFrame() {
        frameHandle = 0;
        if (!transformActive) return;
        if (geoDirty) {
            geoDirty = false;
            measure();
            clampPan();
        }
        writeTransform();
        repoFixed();
        armCrisp();
        if (scale <= 1.0001) armExit();
    }

    // ----- Вход/выход -----------------------------------------------------
    // Страницы со своим transform или CSS zoom на <html> не трогаем: наш
    // transform перезаписал бы их, и зум поехал бы относительно курсора.
    function docCheckOk(el) {
        let cs;
        try {
            cs = getComputedStyle(el);
        } catch (e) {
            return true;
        }
        if (!cs) return true;
        if (cs.transform && cs.transform !== 'none') return false;
        const z = cs.zoom;
        if (z && z !== 'normal' && z !== '1') {
            const n = parseFloat(z);
            if (isFinite(n) && n > 0) {
                const v = z.indexOf('%') >= 0 ? n / 100 : n;
                if (Math.abs(v - 1) > 0.001) return false;
            }
        }
        return true;
    }

    function shouldHandle() {
        if (transformActive) return true;   // наш собственный transform не считаем чужим
        const now = performance.now();
        if (now - docCheckAt < 1000) return docOk;
        docCheckAt = now;
        docOk = docCheckOk(getRoot());
        return docOk;
    }

    function enterTransform() {
        if (transformActive) return;
        const el = getRoot();
        if (!el) return;
        if (!shouldHandle()) return;

        // Порядок здесь принципиален. Прокрутка корня блокируется ДО measure():
        // иначе viewW запомнится вместе с горизонтальным скроллбаром (замерено:
        // 1265 вместо 1280), и вся арифметика привязки к курсору сместится на
        // половину его ширины — при первом шаге контент уезжает на ~7.5 px.
        try { savedRoot = grabStyle(el, ROOT_PROPS); } catch (e) { savedRoot = null; }
        // Если вертикальная полоса прокрутки занимала место, при overflow:hidden
        // она исчезнет и страница станет шире на её ширину — замерено: clientWidth
        // 1265 -> 1280, из-за чего привязка к курсору уезжала на 7.5 px за первый
        // шаг. scrollbar-gutter:stable оставляет ту же полосу зарезервированной,
        // и геометрия страницы не меняется вовсе.
        try {
            if ((window.innerWidth || 0) - (el.clientWidth || 0) > 0) {
                setImp(el, 'scrollbar-gutter', 'stable');
            }
        } catch (e) {
            // не критично
        }
        try {
            setImp(el, 'overflow', 'hidden');
        } catch (e) {
            // не критично: останется нативный скролл
        }
        try {
            const bd = document.body;
            if (bd) {
                savedBodyOverflow = getComputedStyle(bd).overflow;
                setImp(bd, 'overflow', 'hidden');
            }
        } catch (e) {
            savedBodyOverflow = null;
        }

        const sx = window.scrollX || 0;
        const sy = window.scrollY || 0;

        // Внезапный scroll-behavior: smooth у страницы сорвал бы scrollTo(0,0).
        try {
            savedScrollBehavior = [];
            const b = document.body;
            savedScrollBehavior.push({ el: el, style: grabStyle(el, ['scroll-behavior']) });
            if (b) savedScrollBehavior.push({ el: b, style: grabStyle(b, ['scroll-behavior']) });
            el.style.setProperty('scroll-behavior', 'auto', 'important');
            if (b) b.style.setProperty('scroll-behavior', 'auto', 'important');
        } catch (e) {
            savedScrollBehavior = null;
        }

        // translate играет роль -scroll: ровно столько, на сколько уедет контент.
        scale = 1;
        tx = -sx;
        ty = -sy;

        // origin — положение border-box <html> при scroll 0 (учитывает margin у html).
        // Читаем до конвертации: тогда syncConv() видит состояние «страница
        // прокручена, transform ещё нет», и local-координаты точны.
        try {
            const rect = el.getBoundingClientRect();
            originX = rect.left + sx;
            originY = rect.top + sy;
        } catch (e) {
            originX = 0;
            originY = 0;
        }

        // Замер до конвертации: scrollWidth страницы, а не раздутый absolute-ами.
        measure();
        // scrollWidth бывает округлён вниз; страховка, чтобы старт был в границах.
        if (baseW < viewW + sx) baseW = viewW + sx;
        if (baseH < viewH + sy) baseH = viewH + sy;
        geoDirty = false;

        try {
            captureNatural = true;
            convertFixedElements();
        } catch (e) {
            // игнорируем ошибки конвертации fixed
        } finally {
            captureNatural = false;
        }

        try {
            window.scrollTo(0, 0);
        } catch (e) {
            // игнорируем
        }

        try {
            setImp(el, 'transform-origin', '0 0');
            setImp(el, 'transition', 'none');
            setImp(el, 'will-change', 'transform');
            // Прокрутка корня должна быть заблокирована. Причина измерена:
            // увеличенный transform-бокс добавляет площадь в scrollable overflow,
            // и если у <html> стоит overflow:auto (так делает DuckDuckGo и многие
            // сайты), появляется горизонтальный скроллбар. Он отнимает 15 px у
            // clientWidth, страница получает resize, пересобирает layout, полоса
            // исчезает — и так по кругу. Наружу это видно как мигание и «уезжающий»
            // контент. overflow:hidden убирает саму причину: ширина вьюпорта
            // перестаёт меняться, а прокрутку всё равно ведёт сам скрипт.
            // Сама блокировка ставится раньше, до measure().
            willChangeOn = true;
        } catch (e) {
            // не критично
        }

        transformActive = true;
        animOn = false;
        writeTransform();
        // Фиксируем стартовое состояние как базу для transition: иначе браузер
        // анимировал бы transform от identity и страница «уезжала» бы на входе.
        try {
            void getComputedStyle(el).transform;
        } catch (e) {
            // игнорируем
        }
        // Калибровка идёт один раз здесь, а не в кадре: элементы с собственным
        // transform (% -центрирование) дают нелинейный остаток, который нельзя
        // вывести формулой, но который стабилен по масштабу.
        try {
            calibrateAllFixed();
        } catch (e) {
            // игнорируем сбой калибровки: без неё элементы всё равно остаются
            // в пределах экрана, просто с точностью до собственного transform
        }
        bindSession();
    }

    function exitToNative() {
        if (!transformActive) {
            detachWheel();
            return;
        }
        const el = getRoot();
        if (frameHandle) {
            cancelAnimationFrame(frameHandle);
            frameHandle = 0;
        }
        if (crispTimer) { clearTimeout(crispTimer); crispTimer = null; }
        if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
        unbindSession();

        transformActive = false;
        willChangeOn = false;
        animOn = false;

        // Нативный скролл туда, где видна та же картинка: scroll = -translate/scale.
        // Берём ровно то состояние, которое сами записали — без чтения стилей
        // (неверный разбор матрицы в момент выхода сдвинул бы всю страницу).
        const backX = scale > 0 ? -tx / scale : -tx;
        const backY = scale > 0 ? -ty / scale : -ty;

        try { restoreFixedElements(); } catch (e) {}

        if (savedRoot && el) putStyle(el, savedRoot);
        savedRoot = null;
        if (savedBodyOverflow !== null) {
            try {
                if (document.body) document.body.style.removeProperty('overflow');
            } catch (e) {}
            savedBodyOverflow = null;
        }

        // Нативный скролл туда, где видна та же картинка (в том же кадре).
        try {
            window.scrollTo(backX, backY);
        } catch (e) {
            // игнорируем
        }

        if (savedScrollBehavior) {
            for (let i = 0; i < savedScrollBehavior.length; i++) {
                putStyle(savedScrollBehavior[i].el, savedScrollBehavior[i].style);
            }
            savedScrollBehavior = null;
        }

        scale = 1;
        tx = 0;
        ty = 0;
        lastWriteTs = 0;
        geoDirty = true;
        detachWheel();
    }

    // ----- Наблюдение за DOM (только пока идёт зум) -----------------------
    let observer = null;
    let observerTimer = null;
    const pendingNodes = [];
    let pendingSet = new WeakSet();
    let fullRescan = false;
    let resizeBound = false;
    let scrollBound = false;
    let lifeBound = false;

    function scheduleScan() {
        if (observerTimer) return;
        observerTimer = setTimeout(scanAdded, 180);
    }

    function queueNode(n) {
        if (!n || n.nodeType !== 1) return;
        if (pendingSet.has(n)) return;
        if (pendingNodes.length >= 200) {
            // Слишком много узлов: полный скан дешевле тысяч поддеревьев.
            fullRescan = true;
            pendingNodes.length = 0;
            return;
        }
        pendingSet.add(n);
        pendingNodes.push(n);
    }

    function onMutations(records) {
        let added = false;
        for (let i = 0; i < records.length; i++) {
            const rec = records[i];
            if (rec.type === 'attributes') {
                const t = rec.target;
                // Свои записи и <html>/<body> игнорируем: это темы и состояния
                // скролла, а полный скан body на каждое изменение — это дорого.
                if (!t || t === root || t === document.body || converted.has(t)) continue;
                queueNode(t);
                added = true;
                continue;
            }
            const nodes = rec.addedNodes;
            for (let j = 0; j < nodes.length; j++) {
                queueNode(nodes[j]);
                added = true;
            }
        }
        if (added) scheduleScan();
    }

    function scanAdded() {
        observerTimer = null;
        if (!transformActive) {
            pendingNodes.length = 0;
            fullRescan = false;
            return;
        }
        if (fullRescan) {
            fullRescan = false;
            pendingNodes.length = 0;
            pendingSet = new WeakSet();
            convertFixedElements();
            refreshGeometry();
            return;
        }
        syncConv();
        foundItems.length = 0;
        for (let i = 0; i < pendingNodes.length; i++) {
            collectFixed(pendingNodes[i], foundItems);
        }
        pendingNodes.length = 0;
        pendingSet = new WeakSet();
        applyFixed(foundItems);
        refreshGeometry();
    }

    // Страница могла дорасти (ленивые картинки, подгрузка ленты). Пока зум
    // активен, обновляем границы — но пишем кадр только если размер изменился.
    function refreshGeometry() {
        const prevW = baseW, prevH = baseH;
        measure();
        if (baseW !== prevW || baseH !== prevH) {
            clampPan();
            scheduleFrame();
        }
    }

    function onScrollLock() {        if (!transformActive) return;
        // Читаем позицию: если её уже держим в нуле — никакой работы.
        if (!window.scrollX && !window.scrollY) return;
        try {
            window.scrollTo(0, 0);
        } catch (e) {
            // игнорируем
        }
    }

    function onResize() {
        if (!transformActive) return;
        geoDirty = true;
        scheduleFrame();
    }

    function onBeforePrint() {
        exitToNative();
    }

    function onPageHide() {
        exitToNative();
    }

    function bindSession() {
        if (!resizeBound) {
            window.addEventListener('resize', onResize, { passive: true });
            resizeBound = true;
        }
        if (!scrollBound) {
            window.addEventListener('scroll', onScrollLock, { passive: true });
            scrollBound = true;
        }
        if (!lifeBound) {
            window.addEventListener('beforeprint', onBeforePrint, { passive: true });
            window.addEventListener('pagehide', onPageHide, { passive: true });
            lifeBound = true;
        }
        if (!observer && document.body && typeof MutationObserver === 'function') {
            try {
                observer = new MutationObserver(onMutations);
                // childList — новые fixed-элементы; attributes — элемент был
                // скрыт (display:none) и его показали уже во время зума.
                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['class', 'style', 'hidden']
                });
            } catch (e) {
                observer = null;
            }
        }
    }

    function unbindSession() {
        if (resizeBound) {
            window.removeEventListener('resize', onResize);
            resizeBound = false;
        }
        if (scrollBound) {
            window.removeEventListener('scroll', onScrollLock);
            scrollBound = false;
        }
        if (lifeBound) {
            window.removeEventListener('beforeprint', onBeforePrint);
            window.removeEventListener('pagehide', onPageHide);
            lifeBound = false;
        }
        if (observer) {
            try { observer.disconnect(); } catch (e) {}
            observer = null;
        }
        if (observerTimer) {
            clearTimeout(observerTimer);
            observerTimer = null;
        }
        pendingNodes.length = 0;
        fullRescan = false;
        pendingSet = new WeakSet();
    }

    // ----- Обработчики ---------------------------------------------------
    // Основной wheel-обработчик вешаем на весь сеанс просмотра, но он крайне
    // дешёвый: два чтения ctrlKey/deltaY и немедленный выход. Так работает и
    // pinch-жест тачпада (он приходит как ctrlKey:true БЕЗ нажатия Ctrl и без
    // keydown), который отложенное подключение по клавише пропустило бы.
    const wheelOpts = { passive: false, capture: true };

    function onWheel(e) {
        const isZoom = e.ctrlKey;
        if (!isZoom && !transformActive) return;
        try {
            if (isZoom) {
                if (!shouldHandle()) return;   // страницу со своим transform/zoom не трогаем
                // На норме и крутят «от себя»: гасим событие, но не входим в
                // зум — иначе каждый тик конвертировал бы fixed-слой и сразу
                // откатывал его (мигание + лишняя работа).
                if (!transformActive && !(e.deltaY < 0)) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                if (!transformActive) {
                    enterTransform();
                    if (!transformActive) return;
                }
                // Нормализация deltaY для разных устройств (в т.ч. pinch-жестов).
                let dy = e.deltaY;
                if (e.deltaMode === 1) dy *= 16;
                else if (e.deltaMode === 2) dy *= 100;
                // Уже на нижней границе и крутят дальше «от себя»: работы нет.
                if (scale <= 1.0001 && dy > 0) return;
                // Считаем от целевого состояния: каждое событие умножает масштаб
                // и заново привязывает ту же точку, поэтому серия событий за кадр
                // складывается правильно, а в покое точка остаётся под курсором.
                const ux = e.clientX - originX;
                const uy = e.clientY - originY;
                const localX = (ux - tx) / scale;
                const localY = (uy - ty) / scale;
                let k = 1 - dy * CONFIG.wheelStep;
                if (!(k > 0.15)) k = 0.15;    // защита от гигантских дельт
                else if (k > 4) k = 4;
                let next = clampScale(scale * k);
                // У самой нижней границы фиксируем ровно 1: иначе остаётся
                // доля процента, из-за которой выход в нативную прокрутку
                // сдвинул бы страницу на доли пикселя.
                if (next <= 1.0001) next = CONFIG.minScale;
                scale = next;
                // Возвращаем ту же точку под курсор.
                tx = ux - localX * scale;
                ty = uy - localY * scale;
                clampPan();
                setTransitionAnimated();
                scheduleFrame();
                return;
            }
            // ----- Прокрутка по увеличенной странице -----
            // Уже на норме: отдаём событие нативному скроллу и сразу выходим.
            if (scale <= 1.0001) {
                exitToNative();
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            // Панорама 1:1: фиксируем живую матрицу и идём без анимации.
            freezeLive();
            let dx = e.deltaX;
            let dy = e.deltaY;
            if (e.deltaMode === 1) {
                dx *= 16;
                dy *= 16;
            } else if (e.deltaMode === 2) {
                dx *= viewW || 800;
                dy *= viewH || 600;
            }
            if ((e.shiftKey && CONFIG.shiftWheelHorizontal) ||
                (e.shiftKey && Math.abs(dx) < 0.0001)) {
                tx -= dy * CONFIG.panSpeed;
            } else {
                tx -= dx * CONFIG.panSpeed;
                ty -= dy * CONFIG.panSpeed;
            }
            clampPan();
            scheduleFrame();
        } catch (err) {
            // Безопасный выход при ошибках
        }
    }

    function attachWheel() {
        try {
            window.addEventListener('wheel', onWheel, wheelOpts);
        } catch (e) {
            // игнорируем
        }
    }

    function detachWheel() {
        // Обработчик постоянный (см. attachWheel внизу): его не нужно
        // переподключать на каждый keydown, и он ловит pinch-жест.
    }

    // Ctrl+колесо и pinch — оба приходят как wheel с ctrlKey. Один постоянный
    // обработчик дешевле, чем переподключение на каждый keydown, и он не
    // пропускает pinch. При обычной прокрутке он выходит за одну проверку.
    attachWheel();

    window.addEventListener('blur', function () {
        // Потеря фокуса не должна оставлять страницу в зум-режиме.
        if (transformActive) exitToNative();
    }, { passive: true });

})();
