/* ===========================================================================
   Exosphere — page behaviour.

   No framework, no build step. The page ships with working fallback markup, so
   everything here is an enhancement over something that already renders.

   Note there is no colour extraction in this file. The poster palette is solved
   at build time by scripts/sync-events.mjs and arrives pre-computed in
   events.json. That is deliberate: reading pixels from an Eventbrite-hosted
   image would taint the canvas under CORS and getImageData would throw, and
   doing it here would also mean a visible flash of the wrong colour on load.
   =========================================================================== */

(() => {
    'use strict';

    // ---------------------------------------------------------- helpers ---

    const $ = (id) => document.getElementById(id);

    function formatDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getMonth() + 1)} . ${p(d.getDate())} . ${String(d.getFullYear()).slice(2)}`;
    }

    function formatDoors(iso, ageLimit) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const hours = d.getHours();
        const suffix = hours >= 12 ? 'PM' : 'AM';
        const h12 = hours % 12 === 0 ? 12 : hours % 12;
        const mins = d.getMinutes();
        const time = mins ? `${h12}:${String(mins).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
        return ageLimit ? `${time} · ${ageLimit}` : time;
    }

    function setText(el, value) {
        if (el && value) el.textContent = value;
    }

    /**
     * For fields that come from the data: write the value even when it is empty,
     * and hide the element rather than leaving it. Skipping empties would leave
     * the static fallback text visible on an event that has no such field — a
     * stale subtitle from the previous event is worse than none at all.
     */
    function setOptional(el, value) {
        if (!el) return;
        el.textContent = value || '';
        el.hidden = !value;
    }

    // ----------------------------------------------------- theme wiring ---

    /**
     * Apply the pre-solved poster palette. Everything that paints a CTA reads
     * these variables, so the primary button and the sticky bar cannot drift.
     */
    function applyTheme(theme) {
        if (!theme) return;
        const root = document.documentElement.style;

        if (theme.fill)   root.setProperty('--cta-fill', theme.fill);
        if (theme.label)  root.setProperty('--cta-label', theme.label);
        if (theme.accent) root.setProperty('--cta-accent', theme.accent);
        if (theme.ring)   root.setProperty('--cta-ring', theme.ring);

        // Hover is a small lift in the same hue rather than a second colour.
        root.setProperty('--cta-fill-hover', theme.fillHover || theme.fill || '');

        // The ring is only drawn when the solver could not reach the object
        // contrast floor on hue alone. Normally it stays at zero width.
        root.setProperty('--cta-ring-width', theme.needsRing ? '2px' : '0px');
    }

    // ------------------------------------------------------- spotlight ---

    function renderSpotlight(ev) {
        if (!ev) return;

        applyTheme(ev.theme);

        setText($('spotlight-title'), ev.name);
        setOptional($('spotlight-subtitle'), ev.subtitle);
        // Hide the whole field, not just the value — an orphaned "Venue" label
        // with nothing under it looks broken.
        setText($('spotlight-venue'), ev.venue);
        const venueField = $('spotlight-venue-field');
        if (venueField) venueField.hidden = !ev.venue;
        setText($('spotlight-date'), formatDate(ev.startLocal || ev.startUtc));
        setText($('hero-date'), formatDate(ev.startLocal || ev.startUtc));
        setText($('spotlight-doors'), formatDoors(ev.startLocal || ev.startUtc, ev.ageLimit));
        setText($('sticky-cta-text'), ev.name);

        // Eyebrow and hero scroll cue must agree about what is below the fold.
        const label = ev.isPast ? 'Most Recent' : 'Next Event';
        const eyebrow = $('spotlight-eyebrow');
        if (eyebrow) eyebrow.textContent = label;
        const cueLabel = $('scroll-cue-label');
        if (cueLabel) cueLabel.textContent = label;

        const poster = $('spotlight-poster');
        if (poster && ev.poster) {
            poster.src = ev.poster;
            poster.alt = `${ev.name} poster`;
        }

        const note = $('ticket-note');
        const ctas = [$('primary-cta'), $('sticky-cta-link')].filter(Boolean);

        for (const cta of ctas) {
            if (ev.url) cta.href = ev.url;

            if (ev.isPast) {
                cta.textContent = 'View Event';
            } else if (ev.isSoldOut) {
                cta.textContent = 'Sold Out';
                cta.setAttribute('aria-disabled', 'true');
            } else {
                cta.textContent = 'Get Tickets';
            }
        }

        if (note) {
            note.textContent = ev.isPast
                ? 'This event has passed — new dates announced soon.'
                : '';
        }
    }

    // --------------------------------------------------------- archive ---

    function renderArchive(events) {
        const section = $('archive');
        const rail = $('archive-rail');
        if (!section || !rail || !Array.isArray(events) || events.length === 0) return;

        rail.replaceChildren(...events.map((ev) => {
            const li = document.createElement('li');
            li.className = 'rail__item';

            const a = document.createElement('a');
            a.className = 'rail__link';
            a.href = ev.url || '#';
            a.target = '_blank';
            a.rel = 'noopener';

            const img = document.createElement('img');
            img.className = 'rail__img';
            img.src = ev.poster || '';
            img.alt = `${ev.name} poster`;
            img.loading = 'lazy';
            img.decoding = 'async';

            const name = document.createElement('p');
            name.className = 'rail__name';
            name.textContent = ev.name;

            const date = document.createElement('p');
            date.className = 'rail__date';
            date.textContent = formatDate(ev.startLocal || ev.startUtc);

            a.append(img, name, date);
            li.append(a);
            return li;
        }));

        section.hidden = false;
        wireRail(rail);
    }

    function wireRail(rail) {
        const prev = $('rail-prev');
        const next = $('rail-next');
        const step = () => rail.clientWidth * 0.8;

        const update = () => {
            const max = rail.scrollWidth - rail.clientWidth - 1;
            if (prev) prev.disabled = rail.scrollLeft <= 0;
            if (next) next.disabled = rail.scrollLeft >= max;
        };

        prev?.addEventListener('click', () => rail.scrollBy({ left: -step(), behavior: 'smooth' }));
        next?.addEventListener('click', () => rail.scrollBy({ left: step(), behavior: 'smooth' }));

        // Keyboard access — the rail is focusable, so arrows should move it.
        rail.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight') { e.preventDefault(); rail.scrollBy({ left: step(), behavior: 'smooth' }); }
            if (e.key === 'ArrowLeft')  { e.preventDefault(); rail.scrollBy({ left: -step(), behavior: 'smooth' }); }
        });

        rail.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        update();
    }

    // ------------------------------------------------------ sticky CTA ---

    /**
     * Show the sticky bar only while the real button is off-screen, so the two
     * never compete for the same click.
     */
    function wireStickyCta() {
        const primary = $('primary-cta');
        const sticky = $('sticky-cta');
        const stickyLink = $('sticky-cta-link');
        if (!primary || !sticky || !('IntersectionObserver' in window)) return;

        const observer = new IntersectionObserver(([entry]) => {
            // Only offer it once the user is past the fold; showing it over the
            // hero would be noise before there is anything to buy.
            const pastHero = window.scrollY > window.innerHeight * 0.6;
            const show = !entry.isIntersecting && pastHero;

            sticky.classList.toggle('is-visible', show);
            sticky.setAttribute('aria-hidden', show ? 'false' : 'true');
            // Keep the hidden duplicate out of the tab order.
            if (stickyLink) stickyLink.tabIndex = show ? 0 : -1;
        }, { rootMargin: '0px 0px -10% 0px' });

        observer.observe(primary);
    }

    // ------------------------------------------------------------- boot ---

    async function boot() {
        wireStickyCta();

        try {
            const res = await fetch('events.json', { cache: 'no-cache' });
            if (!res.ok) throw new Error(`events.json responded ${res.status}`);
            const data = await res.json();

            renderSpotlight(data.spotlight);
            renderArchive(data.archive);
        } catch (err) {
            // The static markup already renders a complete spotlight, so a
            // failure here is a non-event. Log it and leave the page alone.
            console.warn('[exosphere] falling back to static markup:', err.message);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
