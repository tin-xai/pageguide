// XWebAgent - Web Protection Module
// Detects and handles dark patterns, ads, and unsafe content

// ===== DARK PATTERN DEFINITIONS =====

const DARK_PATTERNS = {
  // Fake urgency - Creates false sense of scarcity/time pressure
  fakeUrgency: {
    name: 'Fake Urgency',
    description: 'Creates artificial time pressure to rush your decision',
    icon: '⏰',
    severity: 'warning',
    patterns: [
      /only \d+ left/i,
      /\d+ (people|users|customers) (are )?(viewing|watching|looking)/i,
      /(hurry|act now|don't miss|last chance|limited time)/i,
      /sale ends in/i,
      /offer expires/i,
      /\d+ (minutes?|hours?|days?) left/i,
      /selling fast/i,
      /high demand/i,
      /almost (gone|sold out)/i,
    ]
  },

  // Confirmshaming - Guilt-trips users for declining
  confirmshaming: {
    name: 'Confirmshaming',
    description: 'Uses guilt or shame to manipulate your choice',
    icon: '😢',
    severity: 'warning',
    patterns: [
      /no,? (thanks,? )?i (don't|do not) (want|like|need)/i,
      /i('ll| will) (pass|stay|remain|keep)/i,
      /no,? i('m| am) (not interested|good|fine)/i,
      /i prefer (to )?(pay|paying) (full|more)/i,
      /i hate (saving|discounts|deals)/i,
      /continue without/i,
    ]
  },

  // Hidden costs - Reveals extra charges late
  hiddenCosts: {
    name: 'Hidden Costs',
    description: 'Additional fees revealed late in the process',
    icon: '💰',
    severity: 'danger',
    patterns: [
      /service fee/i,
      /processing fee/i,
      /handling (fee|charge)/i,
      /convenience fee/i,
      /booking fee/i,
      /\+ (tax|taxes|VAT)/i,
      /additional (fee|charge|cost)/i,
    ]
  },

  // Trick questions - Confusing double negatives
  trickQuestions: {
    name: 'Trick Question',
    description: 'Confusing wording designed to trick you',
    icon: '❓',
    severity: 'warning',
    patterns: [
      /don't not/i,
      /uncheck.*(not|don't)/i,
      /check.*(not|don't|no)/i,
      /opt.?out.*(not|don't)/i,
    ]
  },

  // Forced continuity - Hard to cancel subscriptions
  forcedContinuity: {
    name: 'Forced Continuity',
    description: 'Makes it hard to cancel or unsubscribe',
    icon: '🔒',
    severity: 'danger',
    patterns: [
      /call (us |to )?cancel/i,
      /contact (us |support )?(to )?cancel/i,
      /cancel (by|via) (phone|calling)/i,
      /write (to us|a letter)/i,
    ]
  },

  // Misdirection - Visual tricks
  misdirection: {
    name: 'Misdirection',
    description: 'Visual design tricks to mislead you',
    icon: '👁️',
    severity: 'info',
    selectors: [
      // Tiny unsubscribe links
      'a[href*="unsubscribe"]',
      // Pre-checked boxes
      'input[type="checkbox"][checked]',
      'input[type="checkbox"]:checked',
    ]
  },

  // Disguised ads
  disguisedAds: {
    name: 'Disguised Ad',
    description: 'Advertisement made to look like content',
    icon: '📢',
    severity: 'info',
    patterns: [
      /sponsored/i,
      /advertisement/i,
      /promoted/i,
      /paid (content|partnership|post)/i,
      /\bad\b/i,
    ],
    selectors: [
      '[class*="sponsor"]',
      '[class*="advert"]',
      '[id*="sponsor"]',
      '[id*="advert"]',
      '[data-ad]',
      '[data-sponsored]',
      'ins.adsbygoogle',
      '[class*="promoted"]',
    ]
  },

  // Newsletter popups
  newsletterTrap: {
    name: 'Newsletter Trap',
    description: 'Aggressive email signup popup',
    icon: '📧',
    severity: 'info',
    selectors: [
      '[class*="popup"][class*="newsletter"]',
      '[class*="modal"][class*="subscribe"]',
      '[class*="popup"][class*="email"]',
      '[id*="popup"][id*="newsletter"]',
    ]
  },

  // Cookie consent dark patterns
  cookieTricks: {
    name: 'Cookie Manipulation',
    description: 'Makes accepting all cookies easier than rejecting',
    icon: '🍪',
    severity: 'warning',
    selectors: [
      '[class*="cookie"]',
      '[id*="cookie"]',
      '[class*="consent"]',
      '[id*="consent"]',
      '[class*="gdpr"]',
    ]
  }
};

// ===== AD SELECTORS =====

const AD_SELECTORS = [
  // Google Ads
  'ins.adsbygoogle',
  '[id^="google_ads"]',
  '[class*="google-ad"]',
  
  // Generic ad containers
  '[class*="-ad-"]',
  '[class*="_ad_"]',
  '[class*="ad-container"]',
  '[class*="ad-wrapper"]',
  '[class*="ad-slot"]',
  '[class*="advertisement"]',
  '[id*="ad-container"]',
  '[id*="ad-wrapper"]',
  '[data-ad]',
  '[data-ad-slot]',
  
  // Sponsored content
  '[class*="sponsored"]',
  '[class*="promoted"]',
  
  // Common ad networks
  'iframe[src*="doubleclick"]',
  'iframe[src*="googlesyndication"]',
  'iframe[src*="facebook.com/plugins"]',
  
  // Social media embeds that track
  '[class*="social-share"]',
  '[class*="share-buttons"]',
];

// ===== DETECTION FUNCTIONS =====

/**
 * Scan page for dark patterns
 */
function detectDarkPatterns() {
  const findings = [];
  const scannedTexts = new Set();
  
  // Scan text content
  const textElements = document.querySelectorAll('p, span, div, a, button, label, h1, h2, h3, h4, h5, h6, li');
  
  textElements.forEach(el => {
    // Skip our UI
    if (el.closest('[id^="xwebagent"]')) return;
    
    const text = (el.innerText || '').trim();
    if (text.length < 3 || text.length > 200) return;
    if (scannedTexts.has(text)) return;
    scannedTexts.add(text);
    
    // Check each pattern type
    for (const [type, config] of Object.entries(DARK_PATTERNS)) {
      if (config.patterns) {
        for (const pattern of config.patterns) {
          if (pattern.test(text)) {
            findings.push({
              type,
              element: el,
              text: text.slice(0, 100),
              ...config
            });
            break;
          }
        }
      }
    }
  });
  
  // Scan by selectors
  for (const [type, config] of Object.entries(DARK_PATTERNS)) {
    if (config.selectors) {
      config.selectors.forEach(selector => {
        try {
          document.querySelectorAll(selector).forEach(el => {
            if (el.closest('[id^="xwebagent"]')) return;
            findings.push({
              type,
              element: el,
              text: (el.innerText || '').slice(0, 100),
              ...config
            });
          });
        } catch (e) {}
      });
    }
  }
  
  return findings;
}

/**
 * Detect ads on the page
 */
function detectAds() {
  const ads = [];
  
  AD_SELECTORS.forEach(selector => {
    try {
      document.querySelectorAll(selector).forEach(el => {
        if (el.closest('[id^="xwebagent"]')) return;
        if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
        
        ads.push({
          element: el,
          selector: selector,
          size: `${el.offsetWidth}x${el.offsetHeight}`
        });
      });
    } catch (e) {}
  });
  
  return ads;
}

/**
 * Mark detected dark patterns with visual warnings
 */
function markDarkPatterns(findings) {
  let count = 0;
  
  findings.forEach(finding => {
    const el = finding.element;
    if (!el || el.hasAttribute('data-xwebagent-marked')) return;
    
    // Add warning badge
    el.style.position = 'relative';
    el.setAttribute('data-xwebagent-marked', 'true');
    
    const badge = document.createElement('div');
    badge.className = 'xwebagent-dark-pattern-badge';
    badge.setAttribute('data-severity', finding.severity);
    badge.innerHTML = `
      <span class="xwebagent-dp-icon">${finding.icon}</span>
      <span class="xwebagent-dp-label">${finding.name}</span>
      <span class="xwebagent-dp-info" title="${finding.description}">ⓘ</span>
    `;
    
    // Add outline based on severity
    const colors = {
      danger: '#ff4757',
      warning: '#ffa502',
      info: '#1e90ff'
    };
    el.style.outline = `2px dashed ${colors[finding.severity] || colors.info}`;
    el.style.outlineOffset = '2px';
    
    // Position badge
    el.appendChild(badge);
    count++;
  });
  
  return count;
}

/**
 * Hide or blur detected ads
 */
function hideAds(ads, mode = 'blur') {
  let count = 0;
  
  ads.forEach(ad => {
    const el = ad.element;
    if (!el || el.hasAttribute('data-xwebagent-hidden')) return;
    
    el.setAttribute('data-xwebagent-hidden', 'true');
    
    if (mode === 'hide') {
      el.style.display = 'none';
    } else if (mode === 'blur') {
      el.style.filter = 'blur(8px)';
      el.style.opacity = '0.3';
      el.style.pointerEvents = 'none';
      el.style.userSelect = 'none';
    } else if (mode === 'outline') {
      el.style.outline = '3px dashed #ff4757';
      el.style.outlineOffset = '2px';
    }
    
    count++;
  });
  
  return count;
}

/**
 * Remove dark pattern markings
 */
function clearProtectionMarkings() {
  document.querySelectorAll('[data-xwebagent-marked]').forEach(el => {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.removeAttribute('data-xwebagent-marked');
    el.querySelector('.xwebagent-dark-pattern-badge')?.remove();
  });
  
  document.querySelectorAll('[data-xwebagent-hidden]').forEach(el => {
    el.style.display = '';
    el.style.filter = '';
    el.style.opacity = '';
    el.style.pointerEvents = '';
    el.style.userSelect = '';
    el.removeAttribute('data-xwebagent-hidden');
  });
}

/**
 * Full page safety scan
 */
async function runSafetyScan() {
  console.log('🛡️ Running safety scan...');
  
  const darkPatterns = detectDarkPatterns();
  const ads = detectAds();
  
  console.log('🛡️ Found', darkPatterns.length, 'dark patterns,', ads.length, 'ads');
  
  return {
    darkPatterns,
    ads,
    summary: {
      darkPatternCount: darkPatterns.length,
      adCount: ads.length,
      byType: darkPatterns.reduce((acc, f) => {
        acc[f.type] = (acc[f.type] || 0) + 1;
        return acc;
      }, {})
    }
  };
}

/**
 * Apply protection based on user preference
 */
async function applyProtection(options = {}) {
  const {
    markDarkPatterns: shouldMark = true,
    hideAds: shouldHide = true,
    adMode = 'blur' // 'hide', 'blur', 'outline'
  } = options;
  
  const results = await runSafetyScan();
  
  let markedCount = 0;
  let hiddenCount = 0;
  
  if (shouldMark && results.darkPatterns.length > 0) {
    markedCount = markDarkPatterns(results.darkPatterns);
  }
  
  if (shouldHide && results.ads.length > 0) {
    hiddenCount = hideAds(results.ads, adMode);
  }
  
  return {
    ...results,
    markedCount,
    hiddenCount
  };
}

/**
 * Generate safety report
 */
function generateSafetyReport(results) {
  const lines = [];
  
  lines.push('🛡️ **Page Safety Report**\n');
  
  if (results.darkPatterns.length === 0 && results.ads.length === 0) {
    lines.push('✅ No issues detected! This page looks safe.');
    return lines.join('\n');
  }
  
  if (results.darkPatterns.length > 0) {
    lines.push(`⚠️ **${results.darkPatterns.length} Dark Patterns Found:**`);
    
    // Group by type
    const byType = {};
    results.darkPatterns.forEach(dp => {
      if (!byType[dp.type]) byType[dp.type] = [];
      byType[dp.type].push(dp);
    });
    
    for (const [type, items] of Object.entries(byType)) {
      const config = DARK_PATTERNS[type];
      lines.push(`\n${config.icon} **${config.name}** (${items.length})`);
      lines.push(`   ${config.description}`);
      items.slice(0, 2).forEach(item => {
        if (item.text) {
          lines.push(`   • "${item.text.slice(0, 50)}..."`);
        }
      });
    }
  }
  
  if (results.ads.length > 0) {
    lines.push(`\n📢 **${results.ads.length} Ads/Trackers Found**`);
    lines.push('   These have been blurred for your protection.');
  }
  
  lines.push('\n💡 *Tip: I\'ve marked suspicious elements on the page.*');
  
  return lines.join('\n');
}

// ===== QUICK ACTIONS =====

/**
 * Handle protection-related queries
 */
async function handleProtectionQuery(query) {
  const lowerQuery = query.toLowerCase();
  
  // Scan for safety issues
  if (lowerQuery.includes('scan') || lowerQuery.includes('safe') || lowerQuery.includes('check')) {
    const results = await applyProtection();
    return {
      success: true,
      answer: generateSafetyReport(results),
      isProtection: true
    };
  }
  
  // Hide ads
  if (lowerQuery.includes('hide ad') || lowerQuery.includes('block ad') || lowerQuery.includes('remove ad')) {
    const ads = detectAds();
    const count = hideAds(ads, 'hide');
    return {
      success: true,
      answer: count > 0 
        ? `🛡️ Hidden ${count} ads from this page.`
        : '✅ No ads detected on this page.',
      isProtection: true
    };
  }
  
  // Blur ads
  if (lowerQuery.includes('blur ad')) {
    const ads = detectAds();
    const count = hideAds(ads, 'blur');
    return {
      success: true,
      answer: count > 0
        ? `🛡️ Blurred ${count} ads on this page.`
        : '✅ No ads detected on this page.',
      isProtection: true
    };
  }
  
  // Show dark patterns
  if (lowerQuery.includes('dark pattern') || lowerQuery.includes('trick') || lowerQuery.includes('manipulat')) {
    const darkPatterns = detectDarkPatterns();
    const count = markDarkPatterns(darkPatterns);
    return {
      success: true,
      answer: count > 0
        ? `⚠️ Found and marked ${count} dark patterns. Look for the warning badges on the page.`
        : '✅ No obvious dark patterns detected.',
      isProtection: true
    };
  }
  
  // Clear all protections
  if (lowerQuery.includes('clear') || lowerQuery.includes('reset') || lowerQuery.includes('remove mark')) {
    clearProtectionMarkings();
    return {
      success: true,
      answer: '🧹 Cleared all protection markings.',
      isProtection: true
    };
  }
  
  return null;
}

/**
 * Check if query is protection-related
 */
function isProtectionQuery(query) {
  const patterns = [
    /\b(safe|safety|secure|scan|protect)\b/i,
    /\b(dark pattern|trick|manipulat|deceiv|scam)\b/i,
    /\b(hide|block|remove|blur)\s*(ad|ads|advert)/i,
    /\b(ad|ads)\b.*\b(block|hide|remove)/i,
    /\bis.*(this|page).*(safe|secure|trustworth)/i,
  ];
  
  return patterns.some(p => p.test(query));
}

