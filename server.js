async function scrapeLeadWebsite(startUrl, maxPages = 5) {
  const url = normalizeUrl(startUrl);
  const origin = new URL(url).origin;

  const safeMaxPages = Math.min(Number(maxPages) || 3, 5);

  const visitedUrls = new Set();
  const queuedUrls = new Set();

  const pages = [];
  const allEmails = new Set();
  const allPhones = new Set();
  const allSocialLinks = [];

  const crawler = new PlaywrightCrawler({
    // 🔥 HARD LIMIT (CRASH FIX)
    maxRequestsPerCrawl: safeMaxPages,
    maxConcurrency: 1,
    minConcurrency: 1,

    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60000,

    launchContext: {
      launchOptions: {
        headless: true,

        // 🔥 VPS STABLE MODE
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--single-process",
          "--no-zygote",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-sync",
          "--mute-audio",
          "--no-first-run"
        ],
      },
    },

    async requestHandler({ request, page }) {
      const currentUrl = request.url;

      if (visitedUrls.has(currentUrl)) return;
      visitedUrls.add(currentUrl);

      try {
        await page.goto(currentUrl, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
      } catch {
        return;
      }

      const title = await page.title().catch(() => "");
      const bodyText = await page
        .locator("body")
        .innerText()
        .catch(() => "");

      const html = await page.content().catch(() => "");

      const pageEmails = extractEmails(bodyText + " " + html);
      const pagePhones = extractPhones(bodyText);

      pageEmails.forEach((e) => allEmails.add(e));
      pagePhones.forEach((p) => allPhones.add(p));

      const links = await page.$$eval("a[href]", (els) =>
        els.map((a) => a.href)
      ).catch(() => []);

      allSocialLinks.push(...links);

      pages.push({
        url: currentUrl,
        title,
        emails: pageEmails,
        phones: pagePhones,
      });

      // 🔥 STRICT LIMIT (STOP CRASH LOOP)
      if (pages.length >= safeMaxPages) return;

      const newRequests = [];

      for (const link of links.slice(0, 20)) {
        try {
          const cleanLink = link.split("#")[0];
          const parsed = new URL(cleanLink);

          if (
            parsed.origin === origin &&
            !visitedUrls.has(cleanLink) &&
            !queuedUrls.has(cleanLink) &&
            isPriorityPage(cleanLink)
          ) {
            queuedUrls.add(cleanLink);
            newRequests.push({ url: cleanLink });
          }
        } catch {}
      }

      // 🔥 VERY IMPORTANT LIMIT
      await crawler.addRequests(newRequests.slice(0, 2));
    },

    failedRequestHandler({ request }) {
      pages.push({
        url: request.url,
        error: "Scrape failed",
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
