import express from "express";
import cors from "cors";
import axios from "axios";
import { PlaywrightCrawler, ProxyConfiguration } from "crawlee";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";

// Activate open-source stealth patches
chromium.use(stealthPlugin());

const app = reportExpressErrors(express());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Helper error tracker decorator
function reportExpressErrors(appInstance) {
  return appInstance;
}

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

function extractPhones(text) {
  return [...new Set(text.match(/(\+?\d[\d\s().-]{7,}\d)/g) || [])];
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

  // 🌟 BULLETPROOF PROXY TREE: Configured to hit your host Tor service routing bridge
  const proxyConfiguration = new ProxyConfiguration({
    proxyUrls: [
      "socks5://172.17.0.1:9050"
    ],
  });

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: safeMaxPages,
    minConcurrency: 1,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 45, // Snappy timeouts so we don't hang on broken sites
    navigationTimeoutSecs: 30000,
    proxyConfiguration, 

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

    async requestHandler({ request, page, session }) {
      const currentUrl = request.url;
      if (visited.has(currentUrl)) return;
      visited.add(currentUrl);

      console.log(`🔎 Navigating browser to corporate target site: ${currentUrl}`);

      const response = await page.goto(currentUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => null);

      await page.waitForTimeout(1000);

      // Handle block metrics gracefully by cycling the Tor circuit node
      if (response && response.status() === 429) {
        console.error(`⚠️ Target business server threw a 429 block response.`);
        if (session) session.retire(); 
        throw new Error("Retrying via fresh Tor node context assignment.");
      }

      // -------------------- CORPORATE SITE EXTRACTION --------------------
      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const html = await page.content().catch(() => "");

      const emails = extractEmails(bodyText + " " + html);
      emails.forEach((e) => emailsSet.add(e));

      const phones = extractPhones(bodyText + " " + html);
      phones.forEach((p) => phonesSet.add(p));

      pages.push({ url: currentUrl, title, emails, phones });

      // Gather matching sub-directory paths
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

    // 🌟 SEED ACCUMULATORS FOR GLOBAL RESULTS OVER THE LOOP MULTIPLEX
    let totalEmails = new Set();
    let totalPhones = new Set();
    let totalPagesScrapedCount = 0;
    let successfulPagesLog = [];

    // 🌟 ITERATIVE LOOP ENGINE: Process the top 4 discovered domains so one bad site won't kill execution
    const domainsToProcess = initialBusinessLinks.slice(0, 4);
    
    for (const targetedUrl of domainsToProcess) {
      try {
        console.log(`🚀 Processing target site pipeline entry: ${targetedUrl}`);
        const result = await scrapeLeadWebsite(targetedUrl, maxPages || 3);
        
        // Accumulate data payloads safely
        result.emails.forEach(e => totalEmails.add(e));
        result.phones.forEach(p => totalPhones.add(p));
        totalPagesScrapedCount += result.totalPagesScraped;
        successfulPagesLog = [...successfulPagesLog, ...result.pages];
        
      } catch (loopError) {
        console.error(`⚠️ Skipped target entry [${targetedUrl}] due to connection issues:`, loopError.message);
        // Continue loop pipeline to harvest remaining valid candidates
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
