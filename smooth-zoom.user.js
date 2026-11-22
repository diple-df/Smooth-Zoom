// ==UserScript==
// @name         Smooth Zoom to Cursor
// @namespace    https://github.com/diple-df/Smooth-Zoom
// @version      2.8.0
// @description  Trackpad-style smooth zoom to the cursor (Ctrl+Wheel). Compositor-driven CSS transition, at most one transform write per frame, zero work while idle. Crisp at rest, keeps fixed elements. Native Ctrl +/- left intact. Configurable via menu.
// @description:ru Плавный зум к курсору (Ctrl+колесо). Анимация на композиторе, не больше одной записи transform за кадр, в простое скрипт не делает ничего. Чётко в покое, fixed не пропадают. Родной зум Ctrl +/- не трогается. Настраивается через меню.
// @author       diple_df x claude
// @match        *://*/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @downloadURL  https://raw.githubusercontent.com/diple-df/Smooth-Zoom/main/smooth-zoom.user.js
// @updateURL    https://raw.githubusercontent.com/diple-df/Smooth-Zoom/main/smooth-zoom.user.js
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const HTML_NS = 'http://www.w3.org/1999/xhtml';
    // Свойства, которые скрипт трогает у <html> и у конвертированных fixed-элементов.
    const ROOT_PROPS = ['transform', 'transform-origin', 'will-change', 'transition'];
    const FIXED_PROPS = ['position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'margin', 'box-sizing'];

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

    function collectFixed(scope, out) {
        if (!scope || !scope.isConnected) return;
        if (scope.nodeType === 1 && (!scope.namespaceURI || scope.namespaceURI === HTML_NS)) {
            considerNode(scope, out);
        }
        let nodes;
        try {
            nodes = scope.getElementsByTagName('*');
        } catch (e) {
            return;
        }
        for (let i = 0, len = nodes.length; i < len; i++) {
            const el = nodes[i];
            // SVG/MathML не бывают fixed — не тратим на них getComputedStyle.
            if (el.namespaceURI && el.namespaceURI !== HTML_NS) continue;
            considerNode(el, out);
        }
    }

    const foundItems = [];

    function applyFixed(items) {
        const n = items.length;
        if (!n) return;
        const inv = convS > 0 ? 1 / convS : 1;
        for (let i = 0; i < n; i++) {
            const f = items[i];
            const el = f.el;
            if (!el) continue;
            try {
                savedFixed.push({ el: el, style: grabStyle(el, FIXED_PROPS) });
                converted.add(el);
                setImp(el, 'position', 'absolute');
                setImp(el, 'margin', '0');
                setImp(el, 'right', 'auto');
                setImp(el, 'bottom', 'auto');
                // Размер задаём всегда: у absolute своя база для %-ширины, поэтому
                // "как было" надо зафиксировать в px (иначе шапка на всю ширину
                // станет уже/шире после конвертации).
                if (f.borderBox) {
                    setImp(el, 'width', f.w + 'px');
                    setImp(el, 'height', f.h + 'px');
                } else {
                    // content-box: rect/offsetWidth включают padding+border
                    setImp(el, 'width', Math.max(0, f.w - f.pl - f.pr - f.bl - f.br) + 'px');
                    setImp(el, 'height', Math.max(0, f.h - f.pt - f.pb - f.bt - f.bb) + 'px');
                }
                setImp(el, 'left', f.left + 'px');
                setImp(el, 'top', f.top + 'px');
            } catch (e) {
                // пропускаем
            }
        }

        // Поправка на offsetParent: сначала все чтения, потом все записи.
        for (let k = 0; k < n; k++) {
            const f = items[k];
            try {
                f.nr = f.el.getBoundingClientRect();
            } catch (e) {
                f.nr = f.rect;
            }
        }
        for (let m = 0; m < n; m++) {
            const f = items[m];
            const nr = f.nr;
            if (!nr) continue;
            const dx = (f.rect.left - nr.left) * inv;
            const dy = (f.rect.top - nr.top) * inv;
            if (dx || dy) {
                try {
                    setImp(f.el, 'left', (f.left + dx) + 'px');
                    setImp(f.el, 'top', (f.top + dy) + 'px');
                } catch (e) {
                    // пропускаем
                }
            }
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
            convertFixedElements();
        } catch (e) {
            // игнорируем ошибки конвертации fixed
        }

        try {
            window.scrollTo(0, 0);
        } catch (e) {
            // игнорируем
        }

        try {
            savedRoot = grabStyle(el, ROOT_PROPS);
            setImp(el, 'transform-origin', '0 0');
            setImp(el, 'transition', 'none');
            setImp(el, 'will-change', 'transform');
            willChangeOn = true;
        } catch (e) {
            savedRoot = null;
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
