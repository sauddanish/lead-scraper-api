// ✅ BULLETPROOF ROUTE A: Parse Google Search results layout across all layout variations
      if (currentUrl.includes("google.com/search")) {
        console.log("Analyzing Google search results layout...");
        
        // Wait briefly for common Google page elements to pop up
        await page.waitForSelector("a[href]", { timeout: 5000 }).catch(() => null);
        
        // 🌟 Layer 1: Multi-Selector DOM Extraction targeting all known Google Search variations
        const discoveredLinks = await page.$$eval("a[href]", (elements) => {
          return elements
            .map((el) => el.href)
            .filter((href) => {
              if (!href) return false;
              
              // Filter out Google tracking, ads, maps, and internal service routes
              const blocked = [
                "google.com", "facebook.com", "linkedin.com", "instagram.com",
                "twitter.com", "x.com", "youtube.com", "maps.google", "support.google",
                "accounts.google", "search?", "sorry/", "preferences?", "advanced_search"
              ];
              return !blocked.some((d) => href.includes(d));
            });
        }).catch(() => []);

        // Remove duplicate links cleanly
        let finalLinks = [...new Set(discoveredLinks)];

        // 🌟 Layer 2: Text-matching Fallback (If structural selectors are hidden or heavily obfuscated)
        if (finalLinks.length === 0) {
          console.log("⚠️ Structural extraction returned 0, running deep text HTML fallback parser...");
          const htmlContent = await page.content().catch(() => "");
          finalLinks = extractBusinessLinks(htmlContent);
        }

        console.log(`✅ Successfully extracted ${finalLinks.length} target business domains from Google Search results!`);

        if (finalLinks.length === 0) {
          console.error("❌ Critical: No business domains could be extracted from this proxy session view.");
          return;
        }

        const targetRequests = [];
        // Take the top unique business websites to crawl deeply for contact records
        for (const link of finalLinks.slice(0, 5)) {
          const cleanLink = link.split("#")[0];
          if (!visited.has(cleanLink) && !queued.has(cleanLink)) {
            queued.add(cleanLink);
            businessLinksSet.add(cleanLink);
            targetRequests.push({ url: cleanLink });
          }
        }

        if (targetRequests.length > 0) {
          console.log(`Adding ${targetRequests.length} verified business websites to the deep crawler queue...`);
          await crawler.addRequests(targetRequests);
        }
        return; 
      }
