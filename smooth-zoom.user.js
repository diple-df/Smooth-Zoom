// ==UserScript==
// @name         Smooth Zoom to Cursor
// @name:ru      Плавный зум к курсору
// @namespace    https://github.com/diple-df/Smooth-Zoom
// @version      2.6.2
// @description  Trackpad-style smooth zoom to the cursor (Ctrl+Wheel). Compositor-driven CSS transition: stays smooth even on heavy pages. Crisp at rest, keeps fixed elements. Native Ctrl +/- left intact.
// @description:ru Плавный зум к курсору (Ctrl+колесо). Анимация на композиторе через CSS transition: остаётся плавной даже на тяжёлых страницах. Чётко в покое, fixed не пропадают. Родной зум Ctrl +/- не трогается.
// @author       diple_df x claude
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/diple-df/Smooth-Zoom/main/smooth-zoom.user.js
// @updateURL    https://raw.githubusercontent.com/diple-df/Smooth-Zoom/main/smooth-zoom.user.js
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // ----- Настройки -----------------------------------------------------
    const CONFIG = {
        minScale: 1,         // минимальный масштаб (1 = реальный размер)
        maxScale: 10,        // максимальный масштаб
        wheelStep: 0.0015,   // чувствительность колеса при зуме
        panSpeed: 1,         // скорость прокрутки по увеличенной странице
        transitionMs: 120,   // длительность плавной доводки масштаба (на GPU)
        crispDelayMs: 200,   // через сколько после остановки перерисовать чётко
    };

    // ----- Состояние -----------------------------------------------------
    // Зум = transform: translate(tx,ty) scale(scale) на <html>, origin 0,0.
    // Анимацию масштаба ведёт CSS transition (композитор), а не rAF в главном
    // потоке — поэтому на тяжёлых страницах нет рывков. Пока активен зум,
    // нативный скролл держим в 0, позицию кодируем в tx/ty.
    let scale = 1;
    let tx = 0, ty = 0;
    let transformActive = false;
    let exitTimer = null;          // отложенный выход в нативное состояние
    let crispTimer = null;         // отложенная «чёткая» перерисовка
    let root = null;
    // Сохранённые inline-стили fixed-элементов (на время зума -> absolute).
    let savedFixed = [];
    // Кэш размеров — чтобы не читать layout каждый раз.
    let viewW = 0, viewH = 0, baseW = 0, baseH = 0;

    function getRoot() {
        if (!root || !root.isConnected) {
            root = document.documentElement;
        }
        return root;
    }

    function clampScale(s) {
        return Math.min(CONFIG.maxScale, Math.max(CONFIG.minScale, s));
    }

    // Замер размеров окна/документа (без масштаба) — редко, не в анимации.
    function measure() {
        const el = getRoot();
        viewW = window.innerWidth || document.documentElement.clientWidth || 0;
        viewH = window.innerHeight || document.documentElement.clientHeight || 0;
        baseW = Math.max(el.scrollWidth || 0, viewW);
        baseH = Math.max(el.scrollHeight || 0, viewH);
    }

    function getSearchRoot() {
        if (document.body) return document.body;
        if (document.documentElement) return document.documentElement;
        return null;
    }

    // ----- fixed -> absolute (чтобы не отрывались и не пропадали) ---------
    function convertFixedElements() {
        savedFixed = [];
        const searchRoot = getSearchRoot();
        if (!searchRoot) return;
        const sx = window.scrollX || 0;
        const sy = window.scrollY || 0;
        let nodes;
        try {
            nodes = searchRoot.getElementsByTagName('*');
        } catch (e) {
            return;
        }

        // Проход 1 — только чтение.
        const found = [];
        const len = nodes.length;
        for (let i = 0; i < len; i++) {
            const el = nodes[i];
            if (!el || el.nodeType !== 1) continue;
            let pos;
            try {
                const cs = getComputedStyle(el);
                pos = cs.position;
            } catch (e) {
                continue;
            }
            if (pos === 'fixed') {
                try {
                    found.push({ el: el, rect: el.getBoundingClientRect() });
                } catch (e) {
                    // пропускаем проблемные элементы
                }
            }
        }
        if (!found.length) return;

        // Проход 2 — только запись.
        for (let j = 0; j < found.length; j++) {
            const f = found[j];
            const el = f.el;
            const rect = f.rect;
            try {
                savedFixed.push({
                    el: el,
                    position: el.style.position,
                    top: el.style.top,
                    left: el.style.left,
                    right: el.style.right,
                    bottom: el.style.bottom,
                    width: el.style.width,
                    height: el.style.height,
                    margin: el.style.margin,
                    boxSizing: el.style.boxSizing
                });
                el.style.position = 'absolute';
                el.style.margin = '0';
                el.style.right = 'auto';
                el.style.bottom = 'auto';
                // Учитываем box-sizing для корректных размеров
                try {
                    const cs2 = getComputedStyle(el);
                    if (cs2.boxSizing === 'border-box') {
                        el.style.width = rect.width + 'px';
                        el.style.height = rect.height + 'px';
                    } else {
                        // content-box: rect включает padding+border, поэтому вычитаем
                        const pl = parseFloat(cs2.paddingLeft) || 0;
                        const pr = parseFloat(cs2.paddingRight) || 0;
                        const pt = parseFloat(cs2.paddingTop) || 0;
                        const pb = parseFloat(cs2.paddingBottom) || 0;
                        const bl = parseFloat(cs2.borderLeftWidth) || 0;
                        const br = parseFloat(cs2.borderRightWidth) || 0;
                        const bt = parseFloat(cs2.borderTopWidth) || 0;
                        const bb = parseFloat(cs2.borderBottomWidth) || 0;
                        el.style.width = Math.max(0, rect.width - pl - pr - bl - br) + 'px';
                        el.style.height = Math.max(0, rect.height - pt - pb - bt - bb) + 'px';
                    }
                } catch (e) {
                    el.style.width = rect.width + 'px';
                    el.style.height = rect.height + 'px';
                }
                el.style.left = (sx + rect.left) + 'px';
                el.style.top = (sy + rect.top) + 'px';
            } catch (e) {
                // пропускаем
            }
        }

        // Проходы 3-4 — поправка на offsetParent (раздельно чтение/запись).
        for (let k = 0; k < found.length; k++) {
            try {
                found[k].nr = found[k].el.getBoundingClientRect();
            } catch (e) {
                found[k].nr = found[k].rect;
            }
        }
        for (let m = 0; m < found.length; m++) {
            const f = found[m];
            try {
                const dx = f.rect.left - f.nr.left;
                const dy = f.rect.top - f.nr.top;
                if (dx || dy) {
                    f.el.style.left = (sx + f.rect.left + dx) + 'px';
                    f.el.style.top = (sy + f.rect.top + dy) + 'px';
                }
            } catch (e) {
                // пропускаем
            }
        }
    }

    function restoreFixedElements() {
        for (let i = savedFixed.length - 1; i >= 0; i--) {
            const s = savedFixed[i];
            const el = s.el;
            if (!el) continue;
            try {
                el.style.position = s.position;
                el.style.top = s.top;
                el.style.left = s.left;
                el.style.right = s.right;
                el.style.bottom = s.bottom;
                el.style.width = s.width;
                el.style.height = s.height;
                el.style.margin = s.margin;
                if (typeof s.boxSizing !== 'undefined') {
                    el.style.boxSizing = s.boxSizing;
                }
            } catch (e) {
                // пропускаем проблемные элементы
            }
        }
        savedFixed = [];
    }

    // ----- Применение transform ------------------------------------------
    // animate=true → плавная доводка масштаба силами композитора (CSS transition).
    function applyTransform(animate) {
        const el = getRoot();
        if (!el) return;
        try {
            el.style.transition = animate ? `transform ${CONFIG.transitionMs}ms ease-out` : 'transform 0s';
            // Используем округление для меньшего количества перерисовок
            el.style.transform =
                `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;
        } catch (e) {
            // игнорируем ошибки стилей
        }
    }

    // Держим will-change только во время активности; после паузы снимаем, чтобы
    // браузер перерисовал страницу чётко (will-change в покое = замыливание).
    function markActiveForCrisp() {
        const el = getRoot();
        if (!el) return;
        try {
            el.style.willChange = 'transform';
        } catch (e) {
            // игнорируем
        }
        if (crispTimer) {
            clearTimeout(crispTimer);
            crispTimer = null;
        }
        crispTimer = setTimeout(() => {
            crispTimer = null;
            if (transformActive) {
                try {
                    getRoot().style.willChange = '';
                } catch (e) {
                    // игнорируем
                }
            }
        }, CONFIG.crispDelayMs);
    }

    // Не даём уехать за края (по кэшу размеров).
    function clampPan() {
        if (viewW <= 0 || viewH <= 0) {
            measure();
        }
        const scaledW = baseW * scale;
        const scaledH = baseH * scale;
        const minTx = Math.min(0, viewW - scaledW);
        const minTy = Math.min(0, viewH - scaledH);
        if (tx > 0) tx = 0;
        if (ty > 0) ty = 0;
        if (tx < minTx) tx = minTx;
        if (ty < minTy) ty = minTy;
    }

    function enterTransform() {
        if (transformActive) return;
        const el = getRoot();
        if (!el) return;
        try {
            const rect = el.getBoundingClientRect();   // rect.left = -scrollX и т.д.
            tx = rect.left || 0;
            ty = rect.top || 0;
        } catch (e) {
            tx = 0;
            ty = 0;
        }
        scale = 1;
        measure();
        try {
            convertFixedElements();        // fixed -> absolute (пока скролл прежний)
        } catch (e) {
            // игнорируем ошибки конвертации fixed
        }
        try {
            window.scrollTo(0, 0);
        } catch (e) {
            // игнорируем
        }
        try {
            el.style.transformOrigin = '0 0';
            el.style.willChange = 'transform';
        } catch (e) {
            // игнорируем
        }
        applyTransform(false);         // стартовая позиция без анимации
        transformActive = true;
    }

    function exitToNative() {
        if (!transformActive && scale <= 1.0001 && tx === 0 && ty === 0) {
            detachWheel();
            return;
        }
        const el = getRoot();
        const keepTx = tx;
        const keepTy = ty;
        try {
            if (el) {
                el.style.transition = 'transform 0s';
                el.style.transform = '';
                el.style.transformOrigin = '';
                el.style.willChange = '';
            }
        } catch (e) {
            // игнорируем
        }
        if (crispTimer) {
            clearTimeout(crispTimer);
            crispTimer = null;
        }
        try {
            restoreFixedElements();
        } catch (e) {
            // игнорируем
        }
        // При scale = 1 достаточно нативного скролла, чтобы вид не дёрнулся.
        try {
            window.scrollTo(-keepTx, -keepTy);
        } catch (e) {
            // игнорируем
        }
        tx = 0; ty = 0; scale = 1;
        transformActive = false;
        detachWheel();
    }

    function scheduleExit() {
        if (exitTimer) {
            clearTimeout(exitTimer);
            exitTimer = null;
        }
        exitTimer = setTimeout(() => {
            exitTimer = null;
            if (transformActive && scale <= 1.0001) {
                exitToNative();
            }
        }, CONFIG.transitionMs + 80);
    }

    function panBy(dx, dy) {
        if (!transformActive) return;
        tx += dx;
        ty += dy;
        clampPan();
        applyTransform(false);         // перемещение мгновенное (translate дешёвый)
    }

    // ----- Обработчики ---------------------------------------------------
    // Тяжёлый (passive:false) wheel-обработчик вешаем ТОЛЬКО когда зажат Ctrl
    // или идёт зум. При обычном просмотре его нет → нативная плавная прокрутка.
    let ctrlHeld = false;
    let wheelAttached = false;
    const wheelOpts = { passive: false, capture: true };

    function onWheel(e) {
        try {
            if (e.ctrlKey) {
                // ----- Зум к курсору -----
                e.preventDefault();
                e.stopPropagation();
                if (exitTimer) {
                    clearTimeout(exitTimer);
                    exitTimer = null;
                }
                if (!transformActive) {
                    enterTransform();
                }
                markActiveForCrisp();
                // Точка документа под курсором (в координатах без масштаба).
                if (scale < CONFIG.minScale) scale = CONFIG.minScale;
                if (scale > CONFIG.maxScale) scale = CONFIG.maxScale;
                const pageX = (e.clientX - tx) / scale;
                const pageY = (e.clientY - ty) / scale;
                // Нормализация deltaY для разных устройств
                let deltaY = e.deltaY;
                if (e.deltaMode === 1) {
                    deltaY *= 16; // строки -> пиксели
                } else if (e.deltaMode === 2) {
                    deltaY *= 100; // страницы -> пиксели
                }
                const delta = -deltaY * CONFIG.wheelStep;
                const newScale = clampScale(scale * (1 + delta));
                scale = newScale;
                // Возвращаем эту точку под курсор на новом масштабе.
                tx = e.clientX - pageX * scale;
                ty = e.clientY - pageY * scale;
                clampPan();
                applyTransform(true);      // плавная доводка масштаба на композиторе
                if (scale <= 1.0001) {
                    scheduleExit();
                }
                return;
            }
            // ----- Прокрутка по увеличенной странице -----
            if (transformActive) {
                e.preventDefault();
                e.stopPropagation();
                let deltaX = e.deltaX;
                let deltaY = e.deltaY;
                if (e.deltaMode === 1) {
                    deltaX *= 16;
                    deltaY *= 16;
                } else if (e.deltaMode === 2) {
                    deltaX *= viewW || window.innerWidth || 800;
                    deltaY *= viewH || window.innerHeight || 600;
                }
                if (e.shiftKey && Math.abs(deltaX) < 0.0001) {
                    panBy(-deltaY * CONFIG.panSpeed, 0);
                } else {
                    panBy(-deltaX * CONFIG.panSpeed, -deltaY * CONFIG.panSpeed);
                }
                return;
            }
        } catch (err) {
            // Безопасный выход при ошибках
        }
    }

    function attachWheel() {
        if (!wheelAttached) {
            try {
                window.addEventListener('wheel', onWheel, wheelOpts);
                wheelAttached = true;
            } catch (e) {
                // игнорируем
            }
        }
    }
    function detachWheel() {
        if (wheelAttached && !ctrlHeld && !transformActive) {
            try {
                window.removeEventListener('wheel', onWheel, wheelOpts);
            } catch (e) {
                // игнорируем
            }
            wheelAttached = false;
        }
    }

    window.addEventListener('keydown', (e) => {
        try {
            if (e.ctrlKey && !ctrlHeld) {
                ctrlHeld = true;
                attachWheel();
            }
            // Дополнительно поддержка при некоторых браузерах
            if (e.key === 'Control') {
                if (!ctrlHeld) {
                    ctrlHeld = true;
                    attachWheel();
                }
            }
        } catch (err) {
            // игнорируем
        }
    }, { passive: true });
    window.addEventListener('keyup', (e) => {
        try {
            if (!e.ctrlKey && ctrlHeld) {
                ctrlHeld = false;
                detachWheel();
            }
            if (e.key === 'Control' && ctrlHeld) {
                ctrlHeld = false;
                detachWheel();
            }
        } catch (err) {
            // игнорируем
        }
    }, { passive: true });
    window.addEventListener('blur', () => {
        try {
            if (ctrlHeld) {
                ctrlHeld = false;
                detachWheel();
            }
        } catch (err) {
            // игнорируем
        }
    });

    // При ресайзе пере-замеряем размеры и держим границы.
    window.addEventListener('resize', () => {
        try {
            if (transformActive) {
                measure();
                clampPan();
                applyTransform(false);
            } else {
                measure();
            }
        } catch (err) {
            // игнорируем
        }
    }, { passive: true });

    // Обработка изменения ориентации и прочих событий
    window.addEventListener('scroll', () => {
        if (transformActive) {
            // Блокируем нативный скролл при активном зуме
            try {
                window.scrollTo(0, 0);
            } catch (e) {
                // игнорируем
            }
        }
    }, { passive: true });

})();
