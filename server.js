// -------------------- SCRAPER ENGINE --------------------
async function scrapeLeadWebsite(startUrl, maxPages = 3) {
  const safeMaxPages = Math.min(Number(maxPages) || 3, 3);

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

    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60000,

    // ✅ FIXED: Move launcher inside launchContext for Crawlee
    launchContext: {
      launcher: chromium, 
      launchOptions: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled", 
        ],
      },
    },

    // Forge a legitimate human web browser profile fingerprint
    preNavigationHooks: [
      async ({ page }) => {
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        );
      },
    ],

    async requestHandler({ request, page }) {
      const currentUrl = request.url;

      if (visited.has(currentUrl)) return;
      visited.add(currentUrl);

      // Add human-like pacing variance (random 2-4 second hesitation)
      await page.waitForTimeout(Math.floor(Math.random() * 2000) + 2000);

      // Fail-safe check: If caught by Google Captcha, skip immediately
      if (page.url().includes("sorry/index") || (await page.$('iframe[src*="recaptcha"]'))) {
        console.error("⚠️ Blocked by Google Security Shield on: " + currentUrl);
        return;
      }

      await page.goto(currentUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      }).catch(() => null);

      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const html = await page.content().catch(() => "");

      const emails = extractEmails(bodyText + " " + html);
      emails.forEach((e) => emailsSet.add(e));

      const phones = extractPhones(bodyText);
      phones.forEach((p) => phonesSet.add(p));

      const links = await page.$$eval("a[href]", (a) =>
        a.map((x) => x.href)
      ).catch(() => []);

      const businessLinks = extractBusinessLinks(html);
      businessLinks.forEach((l) => businessLinksSet.add(l));

      pages.push({
        url: currentUrl,
        title,
        emails,
        phones,
      });

      const newRequests = [];
      for (const link of businessLinks.slice(0, 5)) {
        try {
          const clean = link.split("#")[0];
          if (!visited.has(clean) && !queued.has(clean)) {
            queued.add(clean);
            newRequests.push({ url: clean });
          }
        } catch {}
      }

      if (newRequests.length > 0) {
        await crawler.addRequests(newRequests.slice(0, 2));
      }
    },
  });

  await crawler.run([{ url: startUrl }]);

  return {
    scrapedDomain: new URL(startUrl).origin,
    totalPagesScraped: pages.length,
    emails: [...emailsSet],
    phones: [...phonesSet],
    businessLinks: [...businessLinksSet],
    pages,
  };
}
