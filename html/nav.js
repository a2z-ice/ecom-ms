/**
 * BookStore Platform — Global Navigation Sidebar
 * Injected into every HTML page for consistent navigation.
 * Desktop: always-visible 260px fixed sidebar.
 * Mobile (<900px): hidden sidebar, hamburger toggle.
 */
(function () {
  'use strict';

  var currentPage = (window.location.pathname.split('/').pop() || 'index.html').split('?')[0].split('#')[0];

  // ── Navigation structure ──
  var sections = [
    {
      title: 'Home',
      links: [
        { label: 'Platform Overview', href: 'index.html' },
        { label: 'Quick Start Guide', href: 'quick-start.html', highlight: true }
      ]
    },
    {
      title: 'AWS (EKS)',
      links: [
        { label: 'Deploy to AWS (EKS)', href: 'deploy-aws.html' },
        { label: 'Single-AZ: AWS EKS', href: 'single-az-eks.html', highlight: true },
        { label: 'HA Multi-AZ: AWS EKS', href: 'ha-multi-az-aws.html' },
        { label: 'Visual: AWS Terraform', href: 'terraform-visual-aws.html' },
        { label: 'Learn EKS (A to Z)', href: 'knowledge-eks.html', highlight: true },
        { label: 'Hardening: AWS EKS', href: 'production-hardening-aws.html' },
        { label: 'Before/After: AWS', href: 'hardening-visual-aws.html' },
        { label: 'Node Scaling Guide', href: 'node-scaling-guide.html', highlight: true }
      ]
    },
    {
      title: 'Azure (AKS)',
      links: [
        { label: 'Deploy to Azure (AKS)', href: 'deploy-azure.html' },
        { label: 'Single-AZ: Azure AKS', href: 'single-az-aks.html', highlight: true },
        { label: 'HA Multi-AZ: Azure AKS', href: 'ha-multi-az-azure.html' },
        { label: 'Visual: Azure Terraform', href: 'terraform-visual-azure.html' },
        { label: 'Learn AKS (A to Z)', href: 'knowledge-aks.html', highlight: true },
        { label: 'Hardening: Azure AKS', href: 'production-hardening-azure.html' },
        { label: 'Before/After: Azure', href: 'hardening-visual-azure.html' },
        { label: 'Node Scaling Guide', href: 'node-scaling-guide.html', highlight: true }
      ]
    },
    {
      title: 'Guides',
      links: [
        { label: 'Technical Reference Manual', href: 'bookstore-platform-manual.html', highlight: true },
        { label: 'User Guide', href: 'user-guide.html' },
        { label: 'Architecture Deep Dive', href: 'architecture.html' },
        { label: 'Enhancement Report', href: 'comprehensive-platform-enhancements.html' }
      ]
    },
    {
      title: 'Go Learning',
      links: [
        { label: 'Learn Go: CSRF Service', href: 'go-learning-csrf-service.html', highlight: true },
        { label: 'Learn Go: K8s Operator', href: 'go-learning-k8s-operator.html', highlight: true }
      ]
    },
    {
      title: 'Infrastructure',
      links: [
        { label: 'CDC Pipeline Hardening', href: 'cdc-hardening.html' },
        { label: 'CDC & Superset Stability', href: 'cdc-superset-stability-guide.html', highlight: true },
        { label: 'Schema Registry', href: 'schema-registry.html' },
        { label: 'PostgreSQL HA (CNPG)', href: 'postgresql-ha.html' },
        { label: 'Sessions 30\u201333: Hardening', href: 'sessions-30-33-architecture-hardening.html' },
        { label: 'Sessions 34\u201335: Infra & Ops', href: 'sessions-34-35-infra-ops-hardening.html' }
      ]
    },
    {
      title: 'CSRF Protection Series',
      links: [
        { label: '\u2460 Gateway CSRF Service', href: 'gateway-csrf-service.html' },
        { label: '\u2461 Redis Token Store (Spring Boot)', href: 'csrf-redis-implementation.html' },
        { label: '\u2462 ext_authz vs Wasm', href: 'csrf-extauthz-vs-wasm.html' },
        { label: '\u2463 Production Audit', href: 'csrf-production-readiness.html' },
        { label: '\u2464 Production Enhancement', href: 'csrf-production-enhancement.html' },
        { label: '\u2465 Clean Code Refactor', href: 'csrf-clean-code-refactor.html' },
        { label: '\u2466 Architecture Deep Dive', href: 'csrf-architecture-deep-dive.html', highlight: true },
        { label: '\u2467 Security Enhancements', href: 'csrf-security-enhancements.html', highlight: true },
        { label: '\u2468 Before vs After (8 Fixes)', href: 'csrf-before-after-comparison.html', highlight: true },
        { label: '\u2469 JWT Introspection', href: 'csrf-jwt-introspection.html', highlight: true },
        { label: '\u246A Sliding TTL & Auto-Regen', href: 'csrf-sliding-ttl-auto-regen.html', highlight: true }
      ]
    },
    {
      title: 'Operations',
      links: [
        { label: 'Inline Python Scripts', href: 'inline-python-scripts.html' },
        { label: 'PgAdmin Connectivity Fix', href: 'pgadmin-connectivity-fix.html' },
        { label: 'PgAdmin Security Review', href: 'pgadmin-security-review.html' },
        { label: 'External DB (Aurora) Guide', href: 'external-database-mtls-guide.html' },
        { label: 'Browser CA Trust Guide', href: 'browser-ca-trust.html', highlight: true }
      ]
    },
    {
      title: 'External',
      links: [
        { label: 'GitHub Repository', href: 'https://github.com/a2z-ice/ecom-ms', external: true },
        { label: 'Architecture Gist', href: 'https://gist.github.com/a2z-ice/75fbc3c000760e1a6a9f03a6e1f9ecdf', external: true }
      ]
    }
  ];

  // ── Build sidebar HTML ──
  var sidebarHTML = '<div class="nav-sidebar-header"><a href="index.html">BookStore Platform</a></div>';
  for (var s = 0; s < sections.length; s++) {
    if (s > 0) sidebarHTML += '<div class="nav-divider"></div>';
    var sec = sections[s];
    sidebarHTML += '<div class="nav-section"><div class="nav-section-title">' + sec.title + '</div>';
    for (var l = 0; l < sec.links.length; l++) {
      var lnk = sec.links[l];
      var cls = 'nav-link';
      if (lnk.href === currentPage) cls += ' active';
      if (lnk.highlight) cls += ' highlight';
      if (lnk.external) cls += ' external';
      var target = lnk.external ? ' target="_blank" rel="noopener"' : '';
      sidebarHTML += '<a href="' + lnk.href + '" class="' + cls + '"' + target + '>' + lnk.label + '</a>';
    }
    sidebarHTML += '</div>';
  }

  // ── Inject CSS ──
  var style = document.createElement('style');
  style.textContent = [
    '/* ── Global Nav: hide old navigation ── */',
    '.topnav, .topbar, .sidebar, .sidebar-overlay { display: none !important; }',

    '/* ── Sidebar ── */',
    '.nav-sidebar { position: fixed; top: 0; left: 0; width: 260px; height: 100vh; background: #1e293b; border-right: 1px solid #334155; z-index: 300; overflow-y: auto; overflow-x: hidden; transform: translateX(0); transition: transform 0.3s cubic-bezier(0.4,0,0.2,1); scrollbar-width: thin; scrollbar-color: #334155 transparent; }',
    '.nav-sidebar::-webkit-scrollbar { width: 4px; }',
    '.nav-sidebar::-webkit-scrollbar-track { background: transparent; }',
    '.nav-sidebar::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }',
    '.nav-sidebar-header { padding: 18px 20px 16px; border-bottom: 1px solid #334155; }',
    '.nav-sidebar-header a { font-weight: 800; font-size: 1.05rem; text-decoration: none; background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }',
    '.nav-section { padding: 12px 0 4px; }',
    '.nav-section-title { padding: 0 20px; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: #64748b; margin-bottom: 6px; }',
    '.nav-link { display: block; padding: 7px 20px 7px 23px; font-size: 0.82rem; color: #94a3b8; text-decoration: none; border-left: 3px solid transparent; transition: all 0.15s ease; line-height: 1.4; }',
    '.nav-link:hover { background: rgba(59,130,246,0.08); color: #e2e8f0; border-left-color: rgba(59,130,246,0.4); }',
    '.nav-link.active { background: rgba(59,130,246,0.12); color: #60a5fa; border-left-color: #3b82f6; font-weight: 600; }',
    '.nav-link.highlight { color: #a78bfa; }',
    '.nav-link.highlight:hover { color: #c4b5fd; }',
    '.nav-link.external::after { content: " \\2197"; font-size: 0.7em; color: #475569; margin-left: 4px; }',
    '.nav-divider { height: 1px; background: #334155; margin: 6px 20px; }',

    '/* ── Topbar ── */',
    '.nav-topbar { position: sticky; top: 0; z-index: 200; height: 48px; background: rgba(15,23,42,0.96); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid #334155; display: flex; align-items: center; padding: 0 20px; gap: 12px; }',
    '.nav-hamburger { display: none; background: none; border: none; cursor: pointer; padding: 6px; flex-direction: column; justify-content: center; gap: 5px; z-index: 301; -webkit-tap-highlight-color: transparent; }',
    '.nav-hamburger span { display: block; width: 20px; height: 2px; background: #e2e8f0; border-radius: 2px; transition: transform 0.3s, opacity 0.3s; }',
    '.nav-hamburger.active span:nth-child(1) { transform: translateY(7px) rotate(45deg); }',
    '.nav-hamburger.active span:nth-child(2) { opacity: 0; }',
    '.nav-hamburger.active span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }',
    '.nav-topbar-brand { font-weight: 600; font-size: 0.85rem; color: #64748b; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.nav-topbar-brand span { color: #94a3b8; font-weight: 400; }',
    '.nav-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 250; opacity: 0; pointer-events: none; transition: opacity 0.3s; }',
    '.nav-overlay.open { opacity: 1; pointer-events: auto; }',

    '/* ── Layout: push content right ── */',
    'body.has-nav-sidebar { margin: 0; padding-left: 260px; }',

    '/* ── Mobile ── */',
    '@media (max-width: 960px) {',
    '  body.has-nav-sidebar { padding-left: 0; }',
    '  .nav-sidebar { transform: translateX(-100%); box-shadow: none; }',
    '  .nav-sidebar.open { transform: translateX(0); box-shadow: 8px 0 24px rgba(0,0,0,0.3); }',
    '  .nav-hamburger { display: flex; }',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  // ── Hide old index.html inline script's toggleSidebar ──
  window.toggleSidebar = function () {};

  // ── Create sidebar element ──
  var sidebar = document.createElement('aside');
  sidebar.className = 'nav-sidebar';
  sidebar.id = 'navSidebar';
  sidebar.innerHTML = sidebarHTML;

  // ── Create overlay ──
  var overlay = document.createElement('div');
  overlay.className = 'nav-overlay';
  overlay.id = 'navOverlay';

  // ── Create topbar ──
  var pageTitle = document.title.split('—')[0].split('--')[0].trim();
  var topbar = document.createElement('div');
  topbar.className = 'nav-topbar';
  topbar.innerHTML =
    '<button class="nav-hamburger" id="navHamburger" aria-label="Toggle navigation">' +
    '<span></span><span></span><span></span></button>' +
    '<a href="index.html" class="nav-topbar-brand">' + pageTitle + '</a>';

  // ── Inject into DOM ──
  document.body.classList.add('has-nav-sidebar');
  document.body.insertBefore(sidebar, document.body.firstChild);
  document.body.insertBefore(overlay, sidebar.nextSibling);

  // Find insertion point for topbar: after old topnav or at start of content
  var oldTopnav = document.querySelector('.topnav');
  var oldTopbar = document.querySelector('.topbar');
  var refNode = oldTopnav || oldTopbar;
  if (refNode && refNode.nextSibling) {
    refNode.parentNode.insertBefore(topbar, refNode.nextSibling);
  } else {
    // Place before the first visible content
    var banner = document.querySelector('.linkedin-banner');
    var container = document.querySelector('.container');
    var target = banner || container;
    if (target) {
      target.parentNode.insertBefore(topbar, target);
    }
  }

  // ── Toggle logic ──
  function navToggle() {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
    document.getElementById('navHamburger').classList.toggle('active');
  }

  document.getElementById('navHamburger').addEventListener('click', navToggle);
  overlay.addEventListener('click', navToggle);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sidebar.classList.contains('open')) {
      navToggle();
    }
  });

  // Close sidebar on link click (mobile)
  sidebar.addEventListener('click', function (e) {
    if (e.target.classList.contains('nav-link') && window.innerWidth <= 960) {
      sidebar.classList.remove('open');
      overlay.classList.remove('open');
      document.getElementById('navHamburger').classList.remove('active');
    }
  });

})();
