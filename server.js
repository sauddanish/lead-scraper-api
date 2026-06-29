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
  return [...new Set(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])];
}

// 🌟 OPTIMIZED CLEAN PHONE EXTRACTOR: Targets regional/international phone patterns & blocks raw numeric coordinates
function extractPhones(text) {
  // Matches typical UAE formats (+971-X-XXX-XXXX, 04 XXX XXXX, 05X XXXXXXX) and general international lines
  const phoneRegex = /(?:\+971|00971|0)[23467958]\s?[\d\s.-]{6,11}\d/g;
  const matches = text.match(phoneRegex) || [];
  
  const cleaned = matches
    .map(num => num.trim().replace(/\s+/g, ' ')) // Strip excess white spacing strings
    .filter(num => {
      const rawDigits = num.replace(/\D/g, '');
      // Ensure the string has a realistic length for a phone number and isn't a string of zeros
      return rawDigits.length >= 7 && rawDigits.length <= 15 && !/^0+$/.test(rawDigits);
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

      // -------------------- CORPORATE SITE EXTRACTION --------------------
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

// -------------------- MAIN API --------------------
app.post("/scrape", async (req, res) => {
  try {
    const { url, query, country, city, industry, jobTitle, maxPages } = req.body;

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
        data: { totalPagesScraped: 0, emails: [], phones: [], businessLinks: [], pages: [] }
      });
    }

    let totalEmails = new Set();
    let totalPhones = new Set();
    let totalPagesScrapedCount = 0;
    let successfulPagesLog = [];

    const domainsToProcess = initialBusinessLinks.slice(0, 4);
    
    for (const targetedUrl of domainsToProcess) {
      try {
        console.log(`🚀 Processing target site pipeline entry directly: ${targetedUrl}`);
        const result = await scrapeLeadWebsite(targetedUrl, maxPages || 3);
        
        result.emails.forEach(e => totalEmails.add(e));
        result.phones.forEach(p => totalPhones.add(p));
        totalPagesScrapedCount += result.totalPagesScraped;
        successfulPagesLog = [...successfulPagesLog, ...result.pages];
        
      } catch (loopError) {
        console.error(`⚠️ Skipped target entry [${targetedUrl}] due to connection issues:`, loopError.message);
      }
    }

    res.json({
      success: true,
      filtersUsed: { url, query, country, city, industry, jobTitle },
      meta: {
        emailsFound: totalEmails.size,
        phonesFound: totalPhones.size,
        businessLinksFound: initialBusinessLinks.length,
        pagesScraped: totalPagesScrapedCount,
      },
      data: {
        scrapedDomain: domainsToProcess[0],
        totalPagesScraped: totalPagesScrapedCount,
        emails: [...totalEmails],
        phones: [...totalPhones],
        businessLinks: initialBusinessLinks,
        pages: successfulPagesLog
      },
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
