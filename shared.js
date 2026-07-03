/**
 * SHARED HELPERS
 * ─────────────────────────────────────────────
 * Progress tracking, topbar/part-nav rendering, cheat-sheet unlock.
 *
 * Public API:
 *   LUC.progress.markSectionComplete(id)
 *   LUC.progress.isSectionComplete(id)
 *   LUC.progress.all()
 *   LUC.progress.reset()
 *
 *   LUC.cheat.unlock()             → set unlocked flag + body class
 *   LUC.cheat.isUnlocked()         → bool
 *
 *   LUC.partNav(config)            → renders sticky bottom part-nav
 *     config: { sectionLabel, part, total, prevHref, prevLabel, nextHref, nextLabel }
 *     part/total optional — omit for pages without "Part X of Y" context
 */

(function () {
    'use strict';

    const SECTIONS_KEY = 'sections-completed';
    const CHEAT_KEY = 'cheat-sheet-unlocked';

    function safeGet(key) {
        try { return JSON.parse(localStorage.getItem(key) || '{}'); }
        catch (e) { return {}; }
    }
    function safeSet(key, obj) {
        try { localStorage.setItem(key, JSON.stringify(obj)); }
        catch (e) {}
    }

    /**
     * Hard-stop every piece of media on the page: all <video>/<audio> elements
     * plus the narration engine. Called on every card change, page navigation,
     * and lightbox open so nothing keeps playing off-screen. Pausing (not
     * unloading) means a card's media resumes from where it left off when revisited.
     */
    function pauseAllMedia(opts) {
        try {
            document.querySelectorAll('video, audio').forEach(function (m) {
                try { if (!m.paused) m.pause(); } catch (e) {}
            });
        } catch (e) {}
        // Card-to-card nav passes keepNarration: the leaving card's video is stopped,
        // but narration keeps its "listening" intent so setCard auto-resumes on the next
        // card (seamless Next). A hard stop (lightbox / page exit) clears that intent.
        if (!(opts && opts.keepNarration) && window.Narration && typeof Narration.pauseAll === 'function') {
            try { Narration.pauseAll(); } catch (e) {}
        }
    }

    const progress = {
        markSectionComplete(id) {
            const all = safeGet(SECTIONS_KEY);
            if (all[id]) return;
            all[id] = new Date().toISOString();
            safeSet(SECTIONS_KEY, all);
            if (window.Analytics && typeof Analytics.completeSection === 'function') {
                Analytics.completeSection(id);
            }
        },
        isSectionComplete(id) {
            return !!safeGet(SECTIONS_KEY)[id];
        },
        all() { return safeGet(SECTIONS_KEY); },
        reset() {
            try {
                localStorage.removeItem(SECTIONS_KEY);
                localStorage.removeItem(CHEAT_KEY);
            } catch (e) {}
        }
    };

    const cheat = {
        unlock() {
            try { localStorage.setItem(CHEAT_KEY, 'true'); } catch (e) {}
            document.body.classList.add('cheat-unlocked');
        },
        isUnlocked() {
            try { return localStorage.getItem(CHEAT_KEY) === 'true'; }
            catch (e) { return false; }
        }
    };

    function currentPage() {
        return (location.pathname.split('/').pop() || '').toLowerCase();
    }

    /**
     * Render (or re-render) the topbar. Single source of truth for the
     * back button + logo + cheat-sheet link pattern across all pages.
     */
    function renderTopbar() {
        const topbar = document.querySelector('.topbar');
        if (!topbar) return;
        const page = currentPage();

        // Left slot stays empty (no "home" button — navigation lives in the top bar
        // itself: the TOC dropdown + search, added by the section script). On pages that
        // mount a progress cluster (the deck), CSS hides .topbar-logo and repositions the
        // cheat link; on the cover the logo shows.
        const back = '<span></span>';

        const refIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:15px;height:15px;vertical-align:-3px;margin-right:5px;"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>';
        const cheatLink = `<a href="assets/dart-diagram.svg" target="_blank" rel="noopener" class="topbar-cheat" style="pointer-events:auto;" title="Quick reference: how to fold the dart" aria-label="Quick reference diagram" onclick="if(window.LUC&&LUC.lightbox){event.preventDefault();LUC.lightbox.open('assets/dart-diagram.svg','Paper dart fold reference diagram');}">${refIcon}<span class="topbar-cheat-text">Quick reference</span></a>`;

        topbar.innerHTML = `
            ${back}
            <a href="index.html" class="topbar-logo" aria-label="Paper Aviation — home">
                <span style="font-weight:800;color:var(--brand-purple-deep);font-size:1.05rem;letter-spacing:-0.01em;white-space:nowrap;">&#9992; Paper Aviation</span>
            </a>
            ${cheatLink}
        `;

        // Track when a learner peeks at the Quick Reference from elsewhere in the module —
        // best signal that the reference is being USED, not just printed.
        const cheatBtn = topbar.querySelector('.topbar-cheat');
        if (cheatBtn) {
            cheatBtn.addEventListener('click', function () {
                if (window.Analytics) {
                    Analytics.track('cheat_sheet_section_clicked', { from: page || 'index.html' });
                }
            });
        }
    }

    /**
     * Render a persistent part-nav at the bottom of the page.
     *
     * Two modes:
     *   (a) Page mode — prev/next are <a href> links that navigate to other pages.
     *       Use cfg.part + cfg.total to show "Part X of Y" dots (optional).
     *   (b) Deck mode — cfg.deck is an element containing .card-slide children.
     *       Prev/next advance cards in-page. When at first/last card, prev/next
     *       fall back to cfg.prevHref / cfg.nextHref to navigate sections.
     *       Dots show card position. Call cfg.onCardChange(index, total) on each move.
     *
     * Common: cfg.sectionLabel shown centered, bold.
     */
    function partNav(cfg) {
        cfg = cfg || {};
        const existing = document.querySelector('.part-nav-wrap');
        if (existing) existing.remove();

        // Detect deck mode
        const deckEl = cfg.deck || null;
        let cards = [];
        let currentCard = 0;
        // Reflect the active card in the URL hash (#slug) so a refresh stays put
        // and individual cards are deep-linkable. Cards opt in via data-slug.
        function syncHash(i) {
            const slug = cards[i] && cards[i].dataset.slug;
            if (slug) { try { history.replaceState(null, '', '#' + slug); } catch (e) {} }
        }
        if (deckEl) {
            cards = Array.from(deckEl.querySelectorAll('.card-slide'));
            const startSlug = (location.hash || '').replace(/^#/, '');
            if (startSlug) {
                const idx = cards.findIndex(c => c.dataset.slug === startSlug);
                if (idx >= 0) currentCard = idx;
            }
            cards.forEach((c, i) => c.classList.toggle('active', i === currentCard));
            syncHash(currentCard);
        }
        const deckMode = cards.length > 0;
        const total = deckMode ? cards.length : (cfg.total || 0);
        const partIdx = deckMode ? 1 : (cfg.part || 0);

        // Clean line arrows (match the topbar icon style) instead of glyph entities.
        const ARROW_L = '<svg class="nav-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="20" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
        const ARROW_R = '<svg class="nav-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';

        // Build prev/next as buttons if deck mode, anchors otherwise
        let prevHtml, nextHtml;
        if (deckMode) {
            prevHtml = `<button type="button" class="part-nav-prev" data-role="prev" title="Back (←)" aria-keyshortcuts="ArrowLeft">${ARROW_L}<span class="part-nav-text">Back</span></button>`;
            nextHtml = `<button type="button" class="part-nav-next" data-role="next" title="Next (→)" aria-keyshortcuts="ArrowRight"><span class="part-nav-text">Next</span>${ARROW_R}</button>`;
        } else {
            // No prevHref in page mode (e.g. the home page) → omit Back entirely.
            prevHtml = cfg.prevHref
                ? `<a href="${cfg.prevHref}" class="part-nav-prev">${ARROW_L}<span class="part-nav-text">${esc(cfg.prevLabel || 'Back')}</span></a>`
                : '';
            nextHtml = cfg.nextHref
                ? `<a href="${cfg.nextHref}" class="part-nav-next"><span class="part-nav-text">${esc(cfg.nextLabel || 'Next')}</span>${ARROW_R}</a>`
                : `<span class="disabled" aria-hidden="true"><span class="part-nav-text">Next</span>${ARROW_R}</span>`;
        }

        const showDots = deckMode && total > 1;

        // Bottom bar: audio transport (left, filled by narration.js) + page nav (right).
        const wrap = document.createElement('footer');
        wrap.className = 'part-nav-wrap';
        const nav = document.createElement('nav');
        nav.className = 'part-nav';
        nav.setAttribute('aria-label', 'Module navigation');
        nav.innerHTML = `
            <div class="part-nav-audio" data-role="audio"></div>
            <div class="part-nav-buttons">
                ${prevHtml}
                ${nextHtml}
            </div>
        `;
        wrap.appendChild(nav);
        document.body.appendChild(wrap);

        // Progress indicator. Both renderings are kept in the DOM; fitProgress() chooses
        // dots (when the row fits) or a continuous fill bar + "X / Y" counter (when the
        // dots would clip — many cards and/or a narrow screen).
        function renderDots(currentIdx) {
            const prog = document.querySelector('.topbar [data-role="prog"]');
            if (prog) {
                const fill = prog.querySelector('.part-track > i');
                if (fill) fill.style.width = (total > 0 ? Math.round((currentIdx / total) * 100) : 0) + '%';
            }
            const dotsEl = document.querySelector('.topbar [data-role="dots"]');
            if (dotsEl) {
                dotsEl.innerHTML = '';
                for (let i = 1; i <= total; i++) {
                    const span = document.createElement('span');
                    if (i < currentIdx) span.className = 'done';
                    else if (i === currentIdx) span.className = 'current';
                    dotsEl.appendChild(span);
                }
            }
            fitProgress();
        }

        // Decide dots vs bar by comparing the dot row's natural width to the space the
        // center column can take (topbar width minus the mirrored side columns, where the
        // search cluster lives). Conservative margins so the dots never actually clip.
        function fitProgress() {
            const tb = document.querySelector('.topbar');
            const prog = tb && tb.querySelector('.topbar-progress');
            if (!prog) return;
            // Phones: always use the streamlined fill bar — a full dot row is cramped and noisy
            // on a narrow screen. Tablet/desktop keep the dots as long as they genuinely fit.
            const isMobile = window.matchMedia('(max-width: 640px)').matches;
            const dotsW = total * 12 + 24;                         // ~7px dot + 5px gap + current pill + margin
            const search = tb.querySelector('.m6-search');
            const searchW = search ? search.offsetWidth : 190;     // assume a wide search until it mounts
            const avail = tb.clientWidth - 2 * searchW - 56;       // both side columns + gaps + safety
            prog.classList.toggle('use-bar', isMobile || dotsW > avail);
        }

        // Top bar: section label + progress dots (replaces the logo). Deferred so it lands
        // AFTER shared.js renderTopbar() runs on DOMContentLoaded (which sets topbar.innerHTML).
        function mountTopProgress() {
            const tb = document.querySelector('.topbar');
            if (!tb || !cfg.sectionLabel) return;
            tb.classList.add('has-progress');
            let host = tb.querySelector('[data-role="topprogress"]');
            if (!host) {
                host = document.createElement('div');
                host.className = 'topbar-progress';
                host.setAttribute('data-role', 'topprogress');
                tb.appendChild(host);
            }
            // Title collapses to its short form (text before the first colon, e.g. "Section 1")
            // when there isn't room for the full label.
            const shortLabel = esc(cfg.sectionLabel.split(':')[0].trim());
            host.innerHTML = `<span class="topbar-section"><span class="ts-full">${esc(cfg.sectionLabel)}</span><span class="ts-short">${shortLabel}</span></span>`
                + (showDots ? '<div class="part-dots" data-role="dots"></div><div class="part-prog" data-role="prog"><span class="part-track"><i></i></span></div>' : '');
            renderDots((deckMode ? currentCard : partIdx - 1) + 1);
            // Re-fit once the search cluster has mounted (it changes the available width),
            // and whenever the window resizes.
            setTimeout(fitProgress, 60);
            window.addEventListener('resize', fitProgress);
            if (deckMode) document.querySelectorAll('.section-marker').forEach(el => { el.style.display = 'none'; });
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountTopProgress);
        else mountTopProgress();

        if (deckMode) {
            // Polite live region so screen readers announce each new card (focus stays
            // on the persistent Next button, so we announce rather than move focus).
            const cardLive = document.createElement('div');
            cardLive.className = 'sr-only';
            cardLive.setAttribute('aria-live', 'polite');
            cardLive.setAttribute('role', 'status');
            document.body.appendChild(cardLive);

            // Transient "finish this step first" message when a gated card blocks advancing.
            let gateEl, gateTimer;
            function gateToast(msg) {
                if (!gateEl) {
                    gateEl = document.createElement('div');
                    gateEl.className = 'part-gate-toast';
                    gateEl.setAttribute('role', 'status');
                    document.body.appendChild(gateEl);
                }
                gateEl.textContent = msg;
                gateEl.classList.add('show');
                clearTimeout(gateTimer);
                gateTimer = setTimeout(() => gateEl.classList.remove('show'), 2600);
            }

            // Single forward-advance chokepoint: both the Next button and the narration
            // ‹ › roll-over call showCard(currentCard + 1), so gating here covers both.
            function showCard(i, opts) {
                // opts.force skips the forward-gate (used by search jump-to, which is
                // meant to reach any card freely for reference).
                if (!(opts && opts.force) && i === currentCard + 1 && typeof cfg.canAdvance === 'function') {
                    const ok = cfg.canAdvance(currentCard);
                    if (ok !== true) {
                        // Give the module a chance to "open the gate" (reveal a breakdown) or
                        // surface what's needed (scroll + pulse a video / question). Only fall
                        // back to the toast when the module doesn't handle it.
                        const handled = (typeof cfg.onGate === 'function') && cfg.onGate(currentCard, ok);
                        if (!handled) gateToast(typeof ok === 'string' ? ok : 'Finish this step to continue.');
                        return;
                    }
                }
                // Stop the leaving card's video, but let narration carry over (setCard
                // resumes it on the new card if the learner was listening).
                pauseAllMedia({ keepNarration: true });
                cards.forEach((c, idx) => c.classList.toggle('active', idx === i));
                currentCard = i;
                syncHash(i);
                renderDots(i + 1);
                const h = cards[i] && cards[i].querySelector('h2, h3');
                cardLive.textContent = `Card ${i + 1} of ${cards.length}${h ? ': ' + h.textContent.trim() : ''}`;
                try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
                if (typeof cfg.onCardChange === 'function') {
                    cfg.onCardChange(i, cards.length);
                }
                updateGate();
            }

            // Gray out the Next button whenever the current card's gate isn't satisfied
            // (video not started, knowledge check not finished). It stays clickable so it
            // still surfaces the "finish this step" toast — it just looks inactive, so the
            // in-card button (e.g. "Next question") reads as the one to use.
            function updateGate() {
                const prevBtn = nav.querySelector('[data-role="prev"]');
                if (prevBtn) prevBtn.style.display = (cfg.hideFirstPrev && currentCard === 0) ? 'none' : '';
                const nextBtn = nav.querySelector('[data-role="next"]');
                if (!nextBtn) return;
                // On the final card there's nowhere to advance to — hide Next entirely.
                if (cfg.hideLastNext && currentCard === cards.length - 1) {
                    nextBtn.style.display = 'none';
                    return;
                }
                nextBtn.style.display = '';
                const gated = (typeof cfg.canAdvance === 'function') && cfg.canAdvance(currentCard) !== true;
                nextBtn.classList.toggle('is-gated', gated);
                nextBtn.setAttribute('aria-disabled', gated ? 'true' : 'false');
            }

            nav.querySelector('[data-role="prev"]').addEventListener('click', () => {
                if (currentCard > 0) showCard(currentCard - 1);
                else if (cfg.prevHref) { pauseAllMedia(); window.location.href = cfg.prevHref; }
            });
            nav.querySelector('[data-role="next"]').addEventListener('click', () => {
                if (currentCard < cards.length - 1) { showCard(currentCard + 1); return; }
                // Last card: gate the exit too, so a final-card check can't be skipped.
                if (cfg.nextHref) {
                    if (typeof cfg.canAdvance === 'function') {
                        const ok = cfg.canAdvance(currentCard);
                        if (ok !== true) { gateToast(typeof ok === 'string' ? ok : 'Finish this step to continue.'); return; }
                    }
                    pauseAllMedia();
                    if (cfg.nextTop) { try { (window.top || window).location.href = cfg.nextHref; return; } catch (e) {} }
                    window.location.href = cfg.nextHref;
                }
            });

            // Keyboard: ← / → drive the deck. When the learner is actively listening,
            // the arrows step the narration line (rolling into the adjacent card at the
            // edges); otherwise they page the deck. Non-listening nav goes through the real
            // Back/Next buttons so all gating + the "finish this step" toast still apply.
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                const t = e.target;
                // Don't steal arrows from form fields, the search combobox, editable content,
                // or while a modal / lightbox / section menu is open (those own the keyboard).
                // A modal or menu open anywhere wins, even if focus wasn't moved into it.
                if (document.querySelector('[aria-modal="true"], .lightbox-overlay, .wiz-modal.open, .m6-toc:not([hidden]), .pa-toc, .pa-search.expanded')) return;
                if (t && t.closest && t.closest('input, textarea, select, [role="combobox"], [contenteditable="true"], .m6-search, .pa-search')) return;
                const N = window.Narration;
                if (N && typeof N.isPlaying === 'function' && N.isPlaying() && typeof N.next === 'function') {
                    e.preventDefault();
                    (e.key === 'ArrowRight' ? N.next : N.prev)();
                    return;
                }
                const btn = nav.querySelector(e.key === 'ArrowRight' ? '[data-role="next"]' : '[data-role="prev"]');
                if (btn && btn.style.display !== 'none' && btn.style.visibility !== 'hidden') { e.preventDefault(); btn.click(); }
            });

            // Touch swipe (phones/tablets only): swipe left = next card, right = back, mirroring
            // the on-screen Back/Next buttons so gating + the "finish this step" toast still apply.
            // Passive listeners never block vertical scroll; skipped on mouse/desktop (fine pointer).
            if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches && deckEl) {
                let sx = 0, sy = 0, st = 0, tracking = false;
                deckEl.addEventListener('touchstart', (e) => {
                    if (e.touches.length !== 1) { tracking = false; return; }
                    const pt = e.touches[0]; sx = pt.clientX; sy = pt.clientY; st = Date.now(); tracking = true;
                }, { passive: true });
                deckEl.addEventListener('touchend', (e) => {
                    if (!tracking) return; tracking = false;
                    const pt = e.changedTouches[0];
                    const dx = pt.clientX - sx, dy = pt.clientY - sy;
                    if (Date.now() - st > 600) return;              // too slow — a drag, not a swipe
                    if (Math.abs(dx) < 55) return;                  // too short to count
                    if (Math.abs(dx) < Math.abs(dy) * 1.6) return;  // mostly vertical — let the page scroll
                    // Don't hijack swipes that begin on a control or a horizontally-scrollable widget.
                    if (e.target.closest && e.target.closest('button, a, input, textarea, select, .smatrix-wrap, .wiz, [role="dialog"], .lightbox-overlay')) return;
                    const btn = nav.querySelector(dx < 0 ? '[data-role="next"]' : '[data-role="prev"]');
                    if (btn && btn.style.display !== 'none' && btn.style.visibility !== 'hidden') btn.click();
                }, { passive: true });
            }

            // Expose controls for external JS (e.g. "try again" buttons inside cards)
            cfg._goto = showCard;
            cfg._refreshGate = updateGate;
            updateGate();
        }

        return {
            goto: (i) => { if (cfg._goto) cfg._goto(i); },
            // Ungated jump to any card (search / deep reference) — bypasses canAdvance.
            jump: (i) => { if (cfg._goto) cfg._goto(i, { force: true }); },
            // Re-evaluate the current card's gate and gray/un-gray Next (call when a gate
            // condition changes — video played, KC answered).
            refreshGate: () => { if (cfg._refreshGate) cfg._refreshGate(); }
        };
    }

    function esc(str) {
        const d = document.createElement('div');
        d.textContent = str == null ? '' : str;
        return d.innerHTML;
    }
    function escAttr(str) { return esc(str).replace(/"/g, '&quot;'); }

    /**
     * Lightbox: click any qualifying image to view it full-size.
     * Skips images inside .topbar, .spot-scene (interactive hotspot scene),
     * elements with .no-lightbox, and SVG-source images (logos/icons).
     */
    const lightbox = {
        open(src, alt, opener) {
            pauseAllMedia();
            const overlay = document.createElement('div');
            overlay.className = 'lightbox-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-label', alt ? ('Enlarged image: ' + alt) : 'Enlarged image');
            const closeBtn = document.createElement('button');
            closeBtn.className = 'lightbox-close';
            closeBtn.setAttribute('aria-label', 'Close');
            closeBtn.textContent = '×';
            const img = document.createElement('img');
            img.src = src;
            img.alt = alt || '';
            overlay.appendChild(closeBtn);
            overlay.appendChild(img);
            document.body.appendChild(overlay);
            const prevOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            const restoreEl = opener || (document.activeElement && document.activeElement.focus ? document.activeElement : null);

            function close() {
                overlay.style.opacity = '0';
                document.removeEventListener('keydown', onKey);
                setTimeout(() => {
                    overlay.remove();
                    document.body.style.overflow = prevOverflow;
                    if (restoreEl && restoreEl.focus) { try { restoreEl.focus(); } catch (e) {} }
                }, 180);
            }
            function onKey(e) {
                if (e.key === 'Escape') { close(); return; }
                // Only the close button is focusable — trap Tab inside the dialog.
                if (e.key === 'Tab') { e.preventDefault(); closeBtn.focus(); }
            }
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay || e.target === closeBtn) close();
            });
            document.addEventListener('keydown', onKey);
            requestAnimationFrame(() => { overlay.classList.add('open'); closeBtn.focus(); });
        },
        init() {
            document.querySelectorAll('img').forEach((img) => {
                if (img.dataset.lightboxBound) return;
                const src = img.currentSrc || img.src || '';
                if (/\.svgz?(\?|$)/i.test(src)) return;
                if (img.closest('.topbar')) return;
                if (img.closest('.spot-scene')) return;
                if (img.closest('.no-lightbox')) return;
                if (img.classList.contains('no-lightbox')) return;
                img.classList.add('lightbox-trigger');
                img.dataset.lightboxBound = '1';
                img.setAttribute('role', 'button');
                img.setAttribute('tabindex', '0');
                img.setAttribute('aria-label', (img.alt ? img.alt + ' — ' : '') + 'view larger');
                const trigger = () => lightbox.open(img.currentSrc || img.src, img.alt, img);
                img.addEventListener('click', trigger);
                img.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); }
                });
            });
        }
    };

    // SR-only orientation for the interactive deck. Engine-level, so every project inherits
    // it free. Names only the always-present controls; the narration line is added only when a
    // player exists, so it never claims a control the page doesn't have.
    function injectA11yIntro() {
        const main = document.querySelector('main') || document.body;
        if (!main || main.querySelector('.sr-a11y-intro')) return;
        const hasNarration = !!window.Narration || !!document.querySelector('.nb-controls');
        const p = document.createElement('p');
        p.className = 'sr-only sr-a11y-intro';
        p.textContent = 'Interactive lesson presented as a series of cards. Move between cards with the Next and Back buttons, or the Left and Right arrow keys. '
            + (hasNarration ? 'Press the Space bar to play or pause the audio narration, and the S key to change its speed. ' : '')
            + 'Some cards ask you to reveal an answer or answer a question before you can continue. Use the section menu in the header to jump to any section you have already reached.';
        main.insertBefore(p, main.firstChild);
    }

    // "More below" cue: a bobbing chevron shown when the page runs past the fold, hidden as
    // the learner nears the end. Engine-level, so every project inherits it.
    let _scrollCue;
    function updateScrollCue() {
        if (!_scrollCue) {
            _scrollCue = document.createElement('div');
            _scrollCue.className = 'scroll-cue';
            _scrollCue.setAttribute('aria-hidden', 'true');
            _scrollCue.innerHTML = '<span class="cue-chev"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>';
            document.body.appendChild(_scrollCue);
        }
        const remaining = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
        _scrollCue.classList.toggle('show', remaining > 100);   // >100 clears the fixed-nav padding
    }
    function initScrollCue() {
        updateScrollCue();
        window.addEventListener('scroll', updateScrollCue, { passive: true });
        window.addEventListener('resize', updateScrollCue);
        // Catch height changes from reveals / wizard updates / image loads, not just scrolls.
        if (window.ResizeObserver) { try { new ResizeObserver(function () { updateScrollCue(); }).observe(document.body); } catch (e) {} }
    }

    function boot() {
        cheat.unlock();
        renderTopbar();
        injectA11yIntro();
        initScrollCue();
        lightbox.init();
        // Stop media when the page is hidden or navigated away from (covers tab
        // switches, back/forward, and bfcache restores resuming audio).
        window.addEventListener('pagehide', pauseAllMedia);
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) pauseAllMedia();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.LUC = window.LUC || {};
    window.LUC.progress = progress;
    window.LUC.cheat = cheat;
    window.LUC.partNav = partNav;
    window.LUC.lightbox = lightbox;
    window.LUC.media = { pauseAll: pauseAllMedia };
    // Draw the eye to a gate we won't auto-satisfy (unstarted video, unanswered question):
    // scroll it into view and pulse a ring. Used by modules' onGate hooks.
    function gatePulse(el) {
        if (!el) return;
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
        el.classList.remove('gate-pulse');
        void el.offsetWidth;   // reflow so the animation can retrigger on repeat presses
        el.classList.add('gate-pulse');
        setTimeout(function () { el.classList.remove('gate-pulse'); }, 2400);
    }
    window.LUC.gatePulse = gatePulse;

})();
