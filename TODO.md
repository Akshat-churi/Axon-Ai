# Axon landing page — ToDo

## [x] Video-backed full-viewport hero
- The hero section uses `relative h-screen w-full overflow-hidden flex flex-col` and is the only page section; there are no other sections or pages.
- The background video is absolutely positioned behind all content (`absolute inset-0 z-0`), uses `https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260714_113715_c7e0daa0-8bdd-4486-a2da-040901f8f0ea.mp4`, has `autoPlay muted loop playsInline`, and is styled `w-full h-[130%] object-cover object-top`.
- All content elements are `relative z-10` above the video.

## [x] Responsive navigation and hero content
- The centered navigation bar uses `pt-4 md:pt-6` and a horizontal pill with `bg-white/70 backdrop-blur-md rounded-xl px-4 md:px-6 py-3 shadow-sm`.
- It contains a custom 24x24 SVG logo in `#1B133C` with a 256x256 viewBox and paths `M 256 256 L 128 256 L 0 128 L 128 128 Z` and `M 256 128 L 128 128 L 0 0 L 128 0 Z`.
- Navigation links “Features”, “Plans”, “Security”, and “About” are hidden on mobile and shown from `sm:` upward, styled `text-sm font-medium text-[#1B133C]/80` with a hover transition to full opacity.
- The centered hero content follows the nav with `mt-8 md:mt-16`, stacked vertically.
- The badge uses `mb-6`, `rounded-xl border border-[#1B133C]/10 bg-white/70 backdrop-blur-sm px-4 py-2 text-sm font-medium` and contains an orange (`bg-orange-500`) rounded `w-5 h-5` square with a bold white “Y”, followed by “Funded by Y Combinator”.
- The heading uses Instrument Serif and `text-4xl sm:text-5xl md:text-7xl lg:text-8xl leading-[0.95] tracking-tight text-[#1B133C] max-w-4xl`; it has two lines: “Deploy digital workers” and “for mundane workflows”.
- The subtitle uses `mt-5 sm:mt-6 max-w-3xl text-xs sm:text-sm md:text-base leading-relaxed text-[#1B133C]/70` and reads: “Eliminate your tedious browser work and 10x your team's capacity. Put intelligent agents on every routine process so you grow faster and deliver more for clients — effortlessly.”
- The “Get Early Access” CTA uses `mt-7 sm:mt-8`, `rounded-xl bg-[#FEFEFE] px-6 sm:px-8 py-3 sm:py-3.5 text-sm font-semibold text-[#1B133C]`, the shadow `0px 4px 12px rgba(0,0,0,0.15)`, hover shadow `0px 6px 16px rgba(0,0,0,0.2)`, and a 300ms all-property transition.

## [x] Typography, palette, and page metadata
- Load Google Fonts Instrument Serif (regular and italic) and Inter (weights 400, 500, 600).
- Body font is Inter and body text color is `#1B133C`; heading font is Instrument Serif.
- Use deep navy `#1B133C` for text, white/translucent white for glass elements, and orange-500 for the Y Combinator badge accent.
- Set the page title to “Axon — Digital Workers for Mundane Workflows”.
- The CSS reset includes `body { font-family: 'Inter', sans-serif; color: #1B133C; }`.
