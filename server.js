require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const AdmZip = require('adm-zip');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

app.post('/api/toggle-trigger', async (req, res) => {
  const { username, password, triggerApiName, status } = req.body;
  const isActive = status.toLowerCase() === 'active';

  // Step 1: Authenticate with Salesforce
  try {
    const loginResponse = await axios.post(`${process.env.LOGIN_URL}/services/oauth2/token`, null, {
      params: {
        grant_type: 'password',
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        username,
        password,
      },
    });

    const { access_token, instance_url } = loginResponse.data;
    console.log('✅ Authenticated to Salesforce');

    // Step 2: Create metadata zip
    const zip = new AdmZip();

    // trigger-meta.xml content
    const triggerMetaXml = `
<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">
    <status>${isActive ? 'Active' : 'Inactive'}</status>
    <apiVersion>58.0</apiVersion>
</ApexTrigger>
`.trim();

    // Add dummy .trigger file (required for deployment)
    zip.addFile(`triggers/${triggerApiName}.trigger`, Buffer.from('// dummy trigger body'));

    // Add .trigger-meta.xml file
    zip.addFile(`triggers/${triggerApiName}.trigger-meta.xml`, Buffer.from(triggerMetaXml));

    // Add package.xml
    const packageXml = `
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>${triggerApiName}</members>
    <name>ApexTrigger</name>
  </types>
  <version>58.0</version>
</Package>
`.trim();

    zip.addFile('package.xml', Buffer.from(packageXml));

    const zipBuffer = zip.toBuffer();

    // Step 3: Deploy to Salesforce Metadata API
    const deployResponse = await axios.post(`${instance_url}/services/Soap/m/58.0`, zipBuffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Authorization': `Bearer ${access_token}`,
        'SOAPAction': 'deploy',
      },
      params: {
        deployOptions: JSON.stringify({
          singlePackage: true,
          rollbackOnError: true,
        }),
      },
    });

    console.log('📦 Deployment sent. Waiting for result...');

    // Since metadata deploy is async, parse the initial deployment ID
    const deployIdMatch = deployResponse.data.match(/<id>(.*?)<\/id>/);
    if (!deployIdMatch) return res.status(500).send('Failed to get deployment ID.');

    const deployId = deployIdMatch[1];

    // Step 4: Poll the deploy status
    let deployDone = false;
    let deployStatus = '';
    let deployResult = '';

    while (!deployDone) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const statusResponse = await axios.post(`${instance_url}/services/Soap/m/58.0`, `
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
        </env:Envelope>
      `.trim(), {
        headers: {
          'Content-Type': 'text/xml',
        },
      });

      const parser = new xml2js.Parser({ explicitArray: false });
      const parsed = await parser.parseStringPromise(statusResponse.data);
      const result = parsed['soapenv:Envelope']['soapenv:Body']['checkDeployStatusResponse']['result'];

      deployDone = result.done === 'true';
      deployStatus = result.status;
      deployResult = result;
    }

    if (deployStatus === 'Succeeded') {
      console.log('✅ Deployment succeeded');
      return res.status(200).json({ message: `Trigger '${triggerApiName}' set to ${status}` });
    } else {
      console.error('❌ Deployment failed:', JSON.stringify(deployResult.details, null, 2));
      return res.status(500).json({
        message: 'Deployment failed',
        errors: deployResult.details?.componentFailures || [],
      });
    }
  } catch (err) {
    console.error('❌ Error:', err.message || err.toString());
    return res.status(500).json({ error: err.message || err.toString() });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
