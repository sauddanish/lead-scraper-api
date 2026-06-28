import express from "express";
import cors from "cors";
import { PlaywrightCrawler } from "crawlee";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function normalizeUrl(input) {
  if (!input) throw new Error("URL is required");

  let url = input.trim();

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  return new URL(url).toString();
}

function extractEmails(text) {
  return [
    ...new Set(
      text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
    ),
  ];
}

function extractPhones(text) {
  return [
    ...new Set(
      text.match(/(\+?\d[\d\s().-]{7,}\d)/g) || []
    ),
  ];
}

function isPriorityPage(url) {
  const lower = url.toLowerCase();

  return (
    lower.includes("contact") ||
    lower.includes("about") ||
    lower.includes("team") ||
    lower.includes("staff") ||
    lower.includes("people") ||
    lower.includes("leadership")
  );
}

function extractSocialLinks(links) {
  return {
    linkedin: links.filter((l) => l.includes("linkedin.com")),
    facebook: links.filter((l) => l.includes("facebook.com")),
    instagram: links.filter((l) => l.includes("instagram.com")),
    twitter: links.filter((l) => l.includes("twitter.com") || l.includes("x.com")),
  };
}

async function scrapeLeadWebsite(startUrl, maxPages = 5) {
  const url = normalizeUrl(startUrl);
  const origin = new URL(url).origin;

  const visitedUrls = new Set();
  const pages = [];

  const allEmails = new Set();
  const allPhones = new Set();
  const allSocialLinks = [];

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: maxPages,
    maxConcurrency: 2,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 45,

    launchContext: {
      launchOptions: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage"
        ],
      },
    },

    async requestHandler({ request, page }) {
      const currentUrl = request.url;
      visitedUrls.add(currentUrl);

      await page.waitForLoadState("domcontentloaded");

      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const html = await page.content().catch(() => "");

      const pageEmails = extractEmails(bodyText + " " + html);
      const pagePhones = extractPhones(bodyText);

      pageEmails.forEach((email) => allEmails.add(email));
      pagePhones.forEach((phone) => allPhones.add(phone));

      const links = await page.$$eval("a[href]", (elements) =>
        elements.map((a) => a.href)
      ).catch(() => []);

      allSocialLinks.push(...links);

      pages.push({
        url: currentUrl,
        title,
        emails: pageEmails,
        phones: pagePhones,
      });

      const newRequests = [];

      for (const link of links) {
        try {
          const cleanLink = link.split("#")[0];
          const parsed = new URL(cleanLink);

          if (
            parsed.origin === origin &&
            !visitedUrls.has(cleanLink) &&
            isPriorityPage(cleanLink)
          ) {
            visitedUrls.add(cleanLink);
            newRequests.push({ url: cleanLink });
          }
        } catch {}
      }

      if (newRequests.length > 0) {
        await crawler.addRequests(newRequests.slice(0, 10));
      }
    },

    failedRequestHandler({ request }) {
      pages.push({
        url: request.url,
        error: "Failed to scrape this page",
      });
    },
  });

  await crawler.run([{ url }]);

  return {
    inputUrl: startUrl,
    scrapedDomain: origin,
    totalPagesScraped: pages.length,
    emails: [...allEmails],
    phones: [...allPhones],
    socials: extractSocialLinks([...new Set(allSocialLinks)]),
    pages,
  };
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Lead Scraper API is running",
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
  });
});

app.post("/scrape", async (req, res) => {
  try {
    const { url, maxPages } = req.body;

    const result = await scrapeLeadWebsite(url, maxPages || 5);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lead Scraper API running on port ${PORT}`);
});
app.post("/scrape", async (req, res) => {
    const { url } = req.body;

    res.json({
        success: true,
        message: "Scrape route working",
        url
    });
});
