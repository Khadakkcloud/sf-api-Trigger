require('dotenv').config();
const express = require('express');
const axios = require('axios');
const JSZip = require('jszip');
const xml2js = require('xml2js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/api/toggle-trigger', async (req, res) => {
    const { username, password, triggerApiName, status } = req.body;

    if (!['Active', 'Inactive'].includes(status)) {
        return res.status(400).json({ error: 'Status must be either Active or Inactive' });
    }

    try {
        // Step 1: Login to Salesforce
        const loginUrl = process.env.LOGIN_URL || 'https://login.salesforce.com';
        const response = await axios.post(`${loginUrl}/services/oauth2/token`, null, {
            params: {
                grant_type: 'password',
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                username,
                password
            }
        });

        const { access_token, instance_url } = response.data;

        // Step 2: Create the .trigger-meta.xml and dummy trigger file
        const zip = new JSZip();

        const triggerMetaXml = `<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">
    <status>${status}</status>
</ApexTrigger>`;

        // Required placeholder trigger body to avoid syntax errors
        const triggerBody = `trigger ${triggerApiName} on Account (before insert) {
    // Dummy body to deploy with updated status
}`;

        zip.file(`triggers/${triggerApiName}.trigger`, triggerBody);
        zip.file(`triggers/${triggerApiName}.trigger-meta.xml`, triggerMetaXml);

        const packageXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>${triggerApiName}</members>
        <name>ApexTrigger</name>
    </types>
    <version>58.0</version>
</Package>`;
        zip.file('package.xml', packageXml);

        const zipData = await zip.generateAsync({ type: 'base64' });

        // Step 3: Deploy via Metadata API (SOAP)
        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
              xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
              xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Header>
    <SessionHeader xmlns="http://soap.sforce.com/2006/04/metadata">
      <sessionId>${access_token}</sessionId>
    </SessionHeader>
  </env:Header>
  <env:Body>
    <deploy xmlns="http://soap.sforce.com/2006/04/metadata">
      <ZipFile>${zipData}</ZipFile>
      <DeployOptions>
        <allowMissingFiles>false</allowMissingFiles>
        <autoUpdatePackage>false</autoUpdatePackage>
        <checkOnly>false</checkOnly>
        <ignoreWarnings>true</ignoreWarnings>
        <performRetrieve>false</performRetrieve>
        <purgeOnDelete>false</purgeOnDelete>
        <rollbackOnError>true</rollbackOnError>
        <runAllTests>false</runAllTests>
        <singlePackage>true</singlePackage>
      </DeployOptions>
    </deploy>
  </env:Body>
</env:Envelope>`;

        const deployRes = await axios.post(`${instance_url}/services/Soap/m/58.0`, soapBody, {
            headers: {
                'Content-Type': 'text/xml',
                'SOAPAction': '""'
            }
        });

        // Extract deployment ID
        const match = deployRes.data.match(/<id>(.*?)<\/id>/);
        if (!match) {
            return res.status(500).json({ error: 'Failed to extract deployment ID' });
        }

        const deployId = match[1];

        // Step 4: Poll the status
        const checkBody = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
              xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
              xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Header>
    <SessionHeader xmlns="http://soap.sforce.com/2006/04/metadata">
      <sessionId>${access_token}</sessionId>
    </SessionHeader>
  </env:Header>
  <env:Body>
    <checkDeployStatus xmlns="http://soap.sforce.com/2006/04/metadata">
      <id>${deployId}</id>
      <includeDetails>true</includeDetails>
    </checkDeployStatus>
  </env:Body>
</env:Envelope>`;

        let done = false;
        let result;
        let retries = 0;

        while (!done && retries < 10) {
            const checkRes = await axios.post(`${instance_url}/services/Soap/m/58.0`, checkBody, {
                headers: {
                    'Content-Type': 'text/xml',
                    'SOAPAction': '""'
                }
            });

            done = checkRes.data.includes('<done>true</done>');
            result = checkRes.data;
            if (!done) await new Promise(resolve => setTimeout(resolve, 3000));
            retries++;
        }

        return res.json({ success: true, response: result });

    } catch (err) {
        console.error('Deployment Error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
