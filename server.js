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
    // Step 1: OAuth Authentication
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

    // Step 2: Prepare ZIP with trigger metadata and package.xml
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

    zip.addFile(`triggers/${triggerApiName}.trigger-meta.xml`, Buffer.from(triggerMetaXml));
    zip.addFile('package.xml', Buffer.from(packageXml));

    const zipBase64 = zip.toBuffer().toString('base64');

    // Step 3: Construct SOAP request
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

    const deployRes = await axios.post(
      `${instance_url}/services/Soap/m/58.0`,
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml',
          'SOAPAction': '""'
        }
      }
    );

    res.send(`Deployment response: ${deployRes.data}`);
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
    res.status(500).send(`Error: ${err.response?.data || err.message}`);
  }
});

app.listen(3000, () => {
  console.log('🚀 Server listening on port 3000');
});
