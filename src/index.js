// ... previous code inside run() up to storeArticles ...
      await this.storeArticles(filtered);

      console.log('[PHASE 2.5] Enriching article content...');
      const enriched = await enrichArticles(filtered);

      // ==================================================================
      // NEW: LAYER 2 KNOWLEDGE VAULT INTEGRATION[cite: 2]
      // ==================================================================
      const DriveClient = require('./drive-client');
      let driveContext = [];
      try {
        const drive = new DriveClient();
        console.log('[Vault] Fetching last 3 archived briefs for pattern recognition...[cite: 2]');
        driveContext = await drive.getRecentBriefsContext(3); // Injects memory[cite: 2]
      } catch (vaultError) {
        console.warn('[Vault] Skipping Drive context lookup:', vaultError.message);
      }
      // ==================================================================

      const analyzed = await this.analyzeArticles(enriched);

      const trends = await this.detectTrends(analyzed);
      const alerts = await this.detectAnomalies(analyzed, trends);

      const safeBriefingData = analyzed.map(article => ({
        ...article,
        content: article.content ? article.content.substring(0, 1000) + '...' : ''
      }));

      // Injects the historical memory directly along with safe briefing data
      const briefing = await this.synthesizer.synthesize(safeBriefingData, driveContext);
      health.recordSynthesis(briefing);

      const emailSent = await this.generateAndSendEmail(analyzed, trends, alerts, briefing);
      health.recordEmail(emailSent);

      await this.updateDashboard(analyzed, trends, alerts, briefing);

      // ==================================================================
      // NEW: ARCHIVE CURRENT BRIEF BACK TO GOOGLE DRIVE VAULT[cite: 2]
      // ==================================================================
      if (briefing) {
        try {
          const drive = new DriveClient();
          const dateStr = this.timestamp.split('T')[0];
          await drive.saveBrief(dateStr, briefing);
        } catch (saveError) {
          console.error('[Vault] Failed to save current run to Google Drive:', saveError.message);
        }
      }
      // ==================================================================

      health.finalize();
      health.persist();
      await this.sendOperatorAlert(health);
      // ... rest of the run execution block ...
