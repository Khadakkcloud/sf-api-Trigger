require('dotenv').config();
const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');

const app = express();
app.use(express.json());

const {
  CLIENT_ID,
  CLIENT_SECRET,
  LOGIN_URL,
} = process.env;

app.post('/api/toggle-trigger', async (req, res) => {
  const { username, password, triggerApiName, status } = req.body;

  if (!username || !password || !triggerApiName || !status) {
    return res.status(400).send('Missing required fields');
  }

  try {
    // Step 1: Authenticate with Salesforce
    const authRes = await axios.post(`${LOGIN_URL}/services/oauth2/token`, null, {
      params: {
        grant_type: 'password',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        username,
        password,
      }
    });

    const access_token = authRes.data.access_token;
    const instance_url = authRes.data.instance_url;

    // Step 2: Prepare deployment ZIP with dummy trigger source + metadata + package.xml
    const zip = new AdmZip();

    const triggerMetaXml = `<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">
  <status>${status}</status>
</ApexTrigger>`;

    const packageXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>${triggerApiName}</members>
    <name>ApexTrigger</name>
  </types>
  <version>58.0</version>
</Package>`;

    // Add dummy source trigger file (required by Salesforce)
    zip.addFile(`triggers/${triggerApiName}.trigger`, Buffer.from('// dummy trigger body'));

    // Add trigger metadata file
    zip.addFile(`triggers/${triggerApiName}.trigger-meta.xml`, Buffer.from(triggerMetaXml));

    // Add package.xml
    zip.addFile('package.xml', Buffer.from(packageXml));

    const zipBase64 = zip.toBuffer().toString('base64');

    // Step 3: Construct SOAP deploy request
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
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
      <ZipFile>${zipBase64}</ZipFile>
      <DeployOptions>
        <rollbackOnError>true</rollbackOnError>
        <singlePackage>true</singlePackage>
      </DeployOptions>
    </deploy>
  </env:Body>
</env:Envelope>`;

    // Step 4: Send deploy request to Metadata API
    const deployRes = await axios.post(
      `${instance_url}/services/Soap/m/58.0`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          'SOAPAction': '""',
        }
      }
    );

    const deployId = /<id>(.*?)<\/id>/.exec(deployRes.data)?.[1];

    // Step 5: Poll deployment status until done
    const finalResult = await checkDeployStatus(instance_url, access_token, deployId);

    res.send(`✅ Deployment completed:\n\n${finalResult}`);
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
    res.status(500).send(`❌ Error: ${err.response?.data || err.message}`);
  }
});

async function checkDeployStatus(instance_url, access_token, deployId) {
  const soapCheckEnvelope = `<?xml version="1.0" encoding="utf-8"?>
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

  let isDone = false;
  let maxAttempts = 15;

  while (!isDone && maxAttempts > 0) {
    const statusRes = await axios.post(
      `${instance_url}/services/Soap/m/58.0`,
      soapCheckEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          'SOAPAction': '""',
        }
      }
    );

    const statusXML = statusRes.data;

    if (statusXML.includes('<done>true</done>')) {
      isDone = true;
      return statusXML;
    }

    console.log('⌛ Deployment still in progress, waiting 3 seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    maxAttempts--;
  }

  return 'Timeout: Deployment did not complete within expected time.';
}

app.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
});
