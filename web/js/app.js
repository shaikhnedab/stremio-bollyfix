document.addEventListener("DOMContentLoaded", () => {
    const lenis = new Lenis({
        duration: 1.2,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        direction: 'vertical',
        gestureDirection: 'vertical',
        smooth: true,
        mouseMultiplier: 1,
        smoothTouch: false,
        touchMultiplier: 2,
        infinite: false,
    });

    function raf(time) {
        lenis.raf(time);
        requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);

    const themeToggle = document.getElementById("themeToggle");
    const htmlEl = document.documentElement;
    const themeIcon = themeToggle.querySelector('.material-symbols-rounded');

    const currentTheme = localStorage.getItem("theme") || "dark";
    htmlEl.setAttribute("data-theme", currentTheme);
    updateThemeIcon(currentTheme);

    themeToggle.addEventListener("click", (e) => {
        const newTheme = htmlEl.getAttribute("data-theme") === "dark" ? "light" : "dark";
        
        function switchTheme() {
            htmlEl.setAttribute("data-theme", newTheme);
            localStorage.setItem("theme", newTheme);
            updateThemeIcon(newTheme);
        }

        if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            switchTheme();
            return;
        }

        const transition = document.startViewTransition(switchTheme);

        transition.ready.then(() => {
            const rect = themeToggle.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            
            const endRadius = Math.hypot(
                Math.max(x, innerWidth - x),
                Math.max(y, innerHeight - y)
            );
            
            const clipPath = [
                `circle(0px at ${x}px ${y}px)`,
                `circle(${endRadius}px at ${x}px ${y}px)`
            ];
            
            document.documentElement.animate(
                {
                    clipPath: newTheme === "dark" ? clipPath.reverse() : clipPath,
                },
                {
                    duration: 500,
                    easing: "cubic-bezier(0.4, 0, 0.2, 1)",
                    pseudoElement: newTheme === "dark" ? "::view-transition-old(root)" : "::view-transition-new(root)",
                }
            );
        });
    });

    function updateThemeIcon(theme) {
        themeIcon.textContent = theme === "dark" ? "light_mode" : "dark_mode";
    }

    if (typeof gsap !== 'undefined') {
        const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        if (!prefersReducedMotion) {
            gsap.from(".hero-badge", { y: 20, opacity: 0, duration: 0.8, ease: "power3.out" });
            gsap.from(".hero-title", { y: 20, opacity: 0, duration: 0.8, delay: 0.1, ease: "power3.out" });
            gsap.from(".hero-description", { y: 20, opacity: 0, duration: 0.8, delay: 0.2, ease: "power3.out" });
            gsap.from(".config-form", { y: 30, opacity: 0, duration: 1, delay: 0.3, ease: "power3.out" });
        }
    }

    const dropdowns = document.querySelectorAll('.custom-dropdown');

    function handleMultiSelect(dropdown, item, items, valueSpan, input) {
        // "All Sources" resets the selection
        if (item.dataset.value === 'all') {
            items.forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            input.value = 'all';
            valueSpan.textContent = item.textContent;
            return;
        }

        // selecting a real source clears "All"
        items.forEach(i => { if (i.dataset.value === 'all') i.classList.remove('selected'); });
        item.classList.toggle('selected');

        const selected = [...items].filter(i => i.classList.contains('selected'));

        if (selected.length === 0) {
            const allItem = [...items].find(i => i.dataset.value === 'all');
            allItem.classList.add('selected');
            input.value = 'all';
            valueSpan.textContent = allItem.textContent;
        } else {
            input.value = selected.map(i => i.dataset.value).join(',');
            valueSpan.textContent = selected.map(i => i.textContent.trim()).join(', ');
        }
    }
    
    dropdowns.forEach(dropdown => {
        const trigger = dropdown.querySelector('.dropdown-trigger');
        const menu = dropdown.querySelector('.dropdown-menu');
        const valueSpan = dropdown.querySelector('.dropdown-value');
        const input = dropdown.querySelector('input');
        const items = dropdown.querySelectorAll('.dropdown-item');
        let isOpen = false;

        gsap.set(menu, { autoAlpha: 0, y: -10, scale: 0.95, transformOrigin: 'top center' });

        function closeMenu() {
            if (!isOpen) return;
            isOpen = false;
            dropdown.classList.remove('open');
            gsap.to(menu, { autoAlpha: 0, y: -10, scale: 0.95, duration: 0.2, ease: "power2.in" });
        }

        function openMenu() {
            if (isOpen) return;
            isOpen = true;
            dropdown.classList.add('open');
            gsap.to(menu, { autoAlpha: 1, y: 0, scale: 1, duration: 0.3, ease: "back.out(1.5)" });
        }

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdowns.forEach(d => { if (d !== dropdown && d.classList.contains('open')) d.querySelector('.dropdown-trigger').click(); });
            isOpen ? closeMenu() : openMenu();
        });

        items.forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();

                if (dropdown.dataset.multi === 'true') {
                    handleMultiSelect(dropdown, item, items, valueSpan, input);
                } else {
                    items.forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    valueSpan.textContent = item.textContent;
                    input.value = item.dataset.value;
                    closeMenu();
                }

                updateLink();
            });
        });

        document.addEventListener('click', (e) => {
            if (isOpen && !dropdown.contains(e.target)) {
                closeMenu();
            }
        });
    });

    document.getElementById('waitToggle').addEventListener('change', updateLink);

    const buttons = document.querySelectorAll('.btn');
    buttons.forEach(btn => {
        btn.addEventListener('mousedown', () => gsap.to(btn, { scale: 0.95, duration: 0.1 }));
        btn.addEventListener('mouseup', () => gsap.to(btn, { scale: 1, duration: 0.2, ease: "back.out(2)" }));
        btn.addEventListener('mouseleave', () => gsap.to(btn, { scale: 1, duration: 0.2, ease: "power2.out" }));
    });

    const rawLinkInput = document.getElementById('rawLinkInput');

    const installAppBtn = document.getElementById('installAppBtn');
    const installWebBtn = document.getElementById('installWebBtn');
    const copyLinkBtn = document.getElementById('copyLinkBtn');
    const toast = document.getElementById('toast');
    const summary = document.getElementById('configSummary');
    const summaryChips = {
        resolution: summary.querySelector('.chip-resolution'),
        sources: summary.querySelector('.chip-sources'),
        layout: summary.querySelector('.chip-layout'),
    };

    const LABELS = {
        resolution: { all: 'All Resolutions', '4k': '4K Only', '1080p': '1080p+', '720p': '720p+', '480p': '480p+' },
        sources: { r2: 'R2', fastcloud: 'FAST CLOUD' },
        layout: { cinematic: 'Cinematic', torrentio: 'Torrentio', badges: 'Badges' },
    };

    const ICONS = { resolution: 'hd', sources: 'cloud', layout: 'dashboard' };

    const previewCard = document.getElementById('previewCard');
    const previewName = document.getElementById('previewName');
    const previewBody = document.getElementById('previewBody');

    const PREVIEWS = {
        cinematic: {
            name: '🐧 BollyFlix ❄️ 1080p',
            body: [
                '🍿 Loki - S01E01',
                '🎞️ 1080p • WEB-DL • MKV • ~4.7 Mbps',
                '💾 1.2 GB',
                '⏱️ 51 min',
                '🎧 Audio: 🇮🇳 Hindi / 🇺🇸 English',
                '📄 Color: SDR',
            ],
        },
        torrentio: {
            name: '🐧 BollyFlix ❄️ 1080p',
            body: [
                '1080p | 1.2 GB | WEB-DL | MKV | ~4.7 Mbps | 51 min',
                '🔊 🇮🇳 Hindi / 🇺🇸 English | SDR',
            ],
        },
        badges: {
            name: '🐧 BollyFlix ❄️ 1080p',
            body: [
                '📺 1080p | 💾 1.2 GB | 🎞️ WEB-DL | ⏱️ 51 min | ~4.7 Mbps | MKV',
                '🔊 🇮🇳 Hindi / 🇺🇸 English',
                '📄 SDR',
            ],
        },
    };

    function updatePreview() {
        const layout = document.getElementById('layout').value;
        const preview = PREVIEWS[layout] || PREVIEWS.cinematic;
        previewCard.className = `preview-card layout-${layout}`;
        previewName.textContent = preview.name;
        previewBody.innerHTML = preview.body
            .map(line => `<div class="preview-line">${line}</div>`)
            .join('');
    }

    function updateSummary() {
        for (const [key, chip] of Object.entries(summaryChips)) {
            const value = document.getElementById(key).value;
            chip.dataset.icon = ICONS[key];
            if (value.includes(',')) {
                chip.textContent = value.split(',')
                    .map(v => (LABELS[key] && LABELS[key][v]) || v)
                    .join(', ');
            } else if (value === 'all' && key === 'sources') {
                chip.textContent = 'All Sources';
            } else {
                chip.textContent = (LABELS[key] && LABELS[key][value]) || value;
            }
        }
    }

    function updateLink() {
        const resValue = document.getElementById('resolution').value;
        const sourcesValue = document.getElementById('sources').value;

        const config = {
            minResolution: resValue === 'all' ? 'any' : resValue,
            sources: sourcesValue === 'all' ? ['r2', 'fastcloud'] : sourcesValue.split(','),
            waitForCloudLink: document.getElementById('waitToggle').checked,
            layout: document.getElementById('layout').value
        };

        const jsonStr = JSON.stringify(config);
        const base64Config = btoa(jsonStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        
        const baseUrl = window.location.origin;
        const manifestUrl = `${baseUrl}/${base64Config}/manifest.json`;
        
        rawLinkInput.value = manifestUrl;
        updateSummary();
        updatePreview();

        const stremioUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://');
        
        installAppBtn.onclick = () => window.location.href = stremioUrl;
        installWebBtn.onclick = () => window.open(`https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`, '_blank');
    }

    updateLink();

    copyLinkBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(rawLinkInput.value).then(() => {
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
            }, 3000);
        });
    });
});
