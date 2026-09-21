## Design System: OMNICEE

### Design Dials
- **Variance:** 4/10 — Balanced / Modern
- **Motion:** 3/10 — Subtle
- **Density:** 9/10 — Dense / Dashboard

### Pattern
- **Name:** Enterprise Gateway
- **Conversion Focus:** Path selection (I am a...). Mega menu navigation. Trust signals prominent. Provide pause/stop for video and rotating logos; stop on focus and reduced motion. Logo carousel controls must be keyboard operable; pause moving media offscreen/hidden and render a static final state under reduced motion.
- **CTA Placement:** Contact Sales (Primary) + Login (Secondary)
- **Color Strategy:** Corporate: Navy/Grey. High integrity. Conservative accents.
- **Sections:** Hero (Video/Mission) > Solutions by Industry > Solutions by Role > Client Logos > Contact Sales

### Style
- **Name:** Dark Mode (OLED)
- **Mode Support:** Light not-recommended | Dark supported
- **Keywords:** Dark theme, low light, high contrast, deep black, midnight blue, eye-friendly, OLED, night mode, power efficient
- **Best For:** Night-mode apps, coding platforms, entertainment, eye-strain prevention, OLED devices, low-light
- **Performance:** cost:low|drivers:none | **Accessibility:** risk:low|requires:contrast-text-4.5,keyboard,visible-focus,reduced-motion

### Colors
| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#0F172A` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#1E293B` | `--color-secondary` |
| On Secondary | `#FFFFFF` | `--color-on-secondary` |
| Accent/CTA | `#22C55E` | `--color-accent` |
| On Accent/CTA | `#0F172A` | `--color-on-accent` |
| Background | `#020617` | `--color-background` |
| Foreground | `#F8FAFC` | `--color-foreground` |
| Card | `#0E1223` | `--color-card` |
| Card Foreground | `#F8FAFC` | `--color-card-foreground` |
| Muted | `#1A1E2F` | `--color-muted` |
| Muted Foreground | `#94A3B8` | `--color-muted-foreground` |
| Border | `#334155` | `--color-border` |
| Destructive | `#EF4444` | `--color-destructive` |
| On Destructive | `#000000` | `--color-on-destructive` |
| Ring | `#FFFFFF` | `--color-ring` |

*Notes: Dark bg + green positive indicators*

### Typography
- **Heading:** Inter
- **Body:** Inter
- **Mood:** dark, cinematic, technical, precision, clean, premium, developer, professional, high-end utility
- **Best For:** Developer tools, fintech/trading, AI dashboards, streaming platforms, high-end productivity apps
- **Google Fonts:** https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap
- **CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
```

### Key Effects
Minimal glow (text-shadow: 0 0 10px), dark-to-light transitions, low white emission, high readability, visible focus

### Motion
**Scroll Reveal** (Subtle) — Trigger: scroll (viewport enter) | Duration: 300-400ms | Easing: `power1.out`
```js
gsap.from(el, { opacity: 0, y: 12, duration: 0.35, ease: 'power1.out', scrollTrigger: { trigger: el, start: 'top 90%', toggleActions: 'play none none reverse' } });
```
*Framework notes: Requires the ScrollTrigger plugin registered once via gsap.registerPlugin(ScrollTrigger); Use matchMedia('(prefers-reduced-motion: reduce)') to skip non-essential motion and render the final state immediately*
- ✅ Keep the y offset small (8-16px) so it reads as a fade, not a slide
- ❌ Don't reveal below-the-fold content needed for SEO/crawlers as invisible-by-default without a no-JS fallback

### Avoid (Anti-patterns)
- Light mode default
- Slow rendering

### Pre-Delivery Checklist
- [ ] No emojis as icons (use SVG: Heroicons/Lucide)
- [ ] cursor-pointer on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard nav
- [ ] prefers-reduced-motion respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px


---

## OMNICEE product overrides (applied on top of generated system)

- **Product:** Institutional AI trading signal terminal (React + Tailwind + lightweight-charts)
- **Keep existing brand fonts:** Inter (UI) + JetBrains Mono (data) + Orbitron (display) — do not switch to Cinzel/Josefin
- **Keep existing tokens:** `--void #05070a`, `--emerald #1fe3a8`, `--coral #ff5470`, `--gold #f0b429`
- **Density:** High (8–12px gaps, dense tables, Bloomberg-style)
- **Motion:** Subtle only; honor `prefers-reduced-motion`
- **Critical UX rules from ui-ux-pro-max:**
  1. Never leave UI frozen without feedback (skeleton / aria-busy / banner)
  2. Form errors: `role="alert"` near the field + recovery path
  3. Touch targets ≥ 44px; `cursor-pointer` on all clickables
  4. Visible `:focus-visible` rings (do not remove focus outlines)
  5. Loading states match wait length — no flicker on fast responses
  6. Charts: legend/tooltips; never encode meaning by color alone
