import express from "express";
import cors from "cors";
import axios from "axios";
import { PlaywrightCrawler } from "crawlee";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";

// Activate open-source stealth patches
chromium.use(stealthPlugin());

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// -------------------- BUILD SEARCH URL --------------------
function buildTargetUrl({ query, country, city, industry, jobTitle }) {
  const searchParts = [query, industry, jobTitle, city, country]
    .filter(Boolean)
    .join(" ");

  return `https://www.google.com/search?q=${encodeURIComponent(searchParts)}&num=10`;
}

// -------------------- BLOCKED DOMAINS --------------------
function isValidBusinessLink(url) {
  const blocked = [
    "google.com", "facebook.com", "linkedin.com", "instagram.com",
    "twitter.com", "x.com", "youtube.com", "maps.google", "support.google",
    "accounts.google"
  ];
  return !blocked.some((d) => url.includes(d));
}

function extractBusinessLinks(html) {
  const links = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
  return links.filter((link) => {
    return isValidBusinessLink(link) && !link.includes("search?") && !link.includes("sorry/");
  });
}

// -------------------- REGEX EXTRACTIONS --------------------
function extractEmails(text) {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const cleanEmails = matches.filter(email => {
    const lower = email.toLowerCase();
    return !lower.includes("2x.webp") && !lower.includes("3x.webp") && !lower.endsWith(".png") && !lower.endsWith(".jpg");
  });
  return [...new Set(cleanEmails)];
}

function extractPhones(text) {
  const phoneRegex = /(?:\+971|00971|971|0)[23467958][\d\s.-]{6,12}\d/g;
  const matches = text.match(phoneRegex) || [];
  
  const cleaned = matches
    .map(num => {
      return num.trim().replace(/\s+/g, ' ');
    })
    .filter(num => {
      if (num.includes('.')) return false;
      const rawDigits = num.replace(/\D/g, '');
      let baseDigits = rawDigits;
      if (baseDigits.startsWith('971')) {
        baseDigits = baseDigits.slice(3);
      }
      if (baseDigits.length < 7 || baseDigits.length > 9) return false;
      if (/^(\d)\1+$/.test(baseDigits)) return false;
      if (baseDigits === "1234567" || baseDigits === "12345678") return false;
      return true;
    })
    .map(num => {
      let formatted = num.replace(/[-.\s]/g, '');
      if (formatted.startsWith('0')) {
        formatted = '+971 ' + formatted.slice(1);
      } else if (formatted.startsWith('971')) {
        formatted = '+' + formatted.slice(0, 3) + ' ' + formatted.slice(3);
      } else if (!formatted.startsWith('+')) {
        formatted = '+971 ' + formatted;
      }
      return formatted;
    });

  return [...new Set(cleaned)];
}

// -------------------- SCRAPER ENGINE --------------------
async function scrapeLeadWebsite(startUrl, maxPages = 3) {
  const safeMaxPages = Math.max(Number(maxPages) || 3, 5);
  const visited = new Set();
  const queued = new Set();

  const pages = [];
  const emailsSet = new Set();
  const phonesSet = new Set();
  const businessLinksSet = new Set();

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: safeMaxPages,
    minConcurrency: 1,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 45, 
    navigationTimeoutSecs: 30000,

    useSessionPool: true,
    sessionPoolOptions: {
      maxPoolSize: 10,
    },

    launchContext: {
      launcher: chromium,
      launchOptions: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled"
        ],
      },
    },

    preNavigationHooks: [
      async ({ page }) => {
        const preWait = Math.floor(Math.random() * 2000) + 1000;
        console.log(`🕒 Simulating human thinking path: Waiting ${preWait}ms...`);
        await page.waitForTimeout(preWait);

        await page.context().setExtraHTTPHeaders({
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9"
        });
      },
    ],

    async requestHandler({ request, page }) {
      const currentUrl = request.url;
      if (visited.has(currentUrl)) return;
      visited.add(currentUrl);

      console.log(`🔎 Navigating browser to corporate target site: ${currentUrl}`);

      await page.goto(currentUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => null);

      await page.waitForTimeout(1000);

      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const html = await page.content().catch(() => "");

      const emails = extractEmails(bodyText + " " + html);
      emails.forEach((e) => emailsSet.add(e));

      const phones = extractPhones(bodyText + " " + html);
      phones.forEach((p) => phonesSet.add(p));

      pages.push({ url: currentUrl, title, emails, phones });

      const subLinks = await page.$$eval("a[href]", (elements) => elements.map((el) => el.href)).catch(() => []);
      const currentOrigin = new URL(currentUrl).origin;
      const internalRequests = [];

      for (const link of subLinks) {
        try {
          const cleanSub = link.split("#")[0];
          if (cleanSub.startsWith(currentOrigin) && !visited.has(cleanSub) && !queued.has(cleanSub)) {
            const lowerPath = cleanSub.toLowerCase();
            if (lowerPath.includes("contact") || lowerPath.includes("about") || lowerPath.includes("info")) {
              queued.add(cleanSub);
              internalRequests.push({ url: cleanSub });
            }
          }
        } catch {}
      }

      if (internalRequests.length > 0) {
        await crawler.addRequests(internalRequests.slice(0, 2));
      }
    },
  });

  await crawler.addRequests([{ url: startUrl }]);
  await crawler.run();

  return {
    scrapedDomain: new URL(startUrl).origin,
    totalPagesScraped: pages.length,
    emails: [...emailsSet],
    phones: [...phonesSet],
    businessLinks: [...businessLinksSet],
    pages,
  };
}

// -------------------- MAIN API (UPDATED FOR INTEGRATION) --------------------
app.post("/api/v1/scrape", async (req, res) => {
  try {
    // 🌟 1. SECURITY CHECK: Protect your scraper from unauthorized access
    const incomingApiKey = req.headers["x-api-key"];
    const secureKey = process.env.SCRAPER_API_SECRET_KEY || "SuperSecretDefaultKey123!";
    
    if (!incomingApiKey || incomingApiKey !== secureKey) {
      return res.status(403).json({ success: false, error: "Unauthorized access: Invalid API Key." });
    }

    const { query, country, city, industry, jobTitle, maxPages } = req.body;

    const VALUESERP_API_KEY = "EEFC9658959749AB9E62FBA99BE06504";
    const searchParts = [query, industry, jobTitle, city, country].filter(Boolean).join(" ");
    console.log(`📡 Fetching clean, unblocked Google SERP data via ValueSerp API for: "${searchParts}"`);

    const serpResponse = await axios.get("https://api.valueserp.com/search", {
      params: {
        api_key: VALUESERP_API_KEY,
        q: searchParts,
        num: 10,
        location: city && country ? `${city},${country}` : undefined
      }
    });

    const organicResults = serpResponse.data.organic_results || [];
    const initialBusinessLinks = organicResults
      .map(item => item.link)
      .filter(link => link && isValidBusinessLink(link));

    console.log(`✅ ValueSerp extraction engine returned ${initialBusinessLinks.length} target corporate domains!`);

    if (initialBusinessLinks.length === 0) {
      return res.json({
        success: true,
        message: "No business links found for these parameters.",
        meta: { emailsFound: 0, phonesFound: 0, businessLinksFound: 0, pagesScraped: 0 },
        data: [] // Kept format flat and simple for your table dashboard
      });
    }

    let totalEmails = new Set();
    let totalPhones = new Set();
    let totalPagesScrapedCount = 0;
    let successfulPagesLog = [];
    
    // Create final structured array to feed directly to frontend table UI rows
    let finalLeadsDashboardArray = [];

    const domainsToProcess = initialBusinessLinks.slice(0, 4);
    
    for (const targetedUrl of domainsToProcess) {
      try {
        console.log(`🚀 Processing target site pipeline entry directly: ${targetedUrl}`);
        const result = await scrapeLeadWebsite(targetedUrl, maxPages || 3);
        
        result.emails.forEach(e => totalEmails.add(e));
        result.phones.forEach(p => totalPhones.add(p));
        totalPagesScrapedCount += result.totalPagesScraped;
        successfulPagesLog = [...successfulPagesLog, ...result.pages];

        // 🌟 2. FORMAT DATA FOR FRONTEND DASHBOARD RECTIFICATION
        // Strip down URL clean domain format to act as Company Name
        const cleanCompanyName = new URL(targetedUrl).hostname.replace('www.', '');

        finalLeadsDashboardArray.push({
          company: cleanCompanyName,
          decision_maker: "Found via Domain Routing", // Placeholder since we scrape domain text directly
          email: result.emails.join(", ") || "N/A",
          phone: result.phones.join(", ") || "N/A",
          industry: industry || "Identified Sub-Sector"
        });
        
      } catch (loopError) {
        console.error(`⚠️ Skipped target entry [${targetedUrl}] due to connection issues:`, loopError.message);
      }
    }

    // Return the clean, simplified array back to your main app backend
    res.json({
      success: true,
      meta: {
        emailsFound: totalEmails.size,
        phonesFound: totalPhones.size,
        businessLinksFound: initialBusinessLinks.length,
        pagesScraped: totalPagesScrapedCount,
      },
      data: finalLeadsDashboardArray
    });

  } catch (error) {
    console.error("❌ Scraper engine operation routine broke:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------- HEALTH ROUTES --------------------
app.get("/", (req, res) => res.json({ success: true, message: "API running" }));
app.get("/health", (req, res) => res.json({ success: true, status: "healthy" }));

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Scraper running on port ${PORT}`);
});
