// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const AdmZip = require('adm-zip');
const fs = require('fs');

const app = express();
app.use(bodyParser.json());

const {
  CLIENT_ID,
  CLIENT_SECRET,
  LOGIN_URL,
} = process.env;

// Auth function
async function authenticate(username, password) {
  const url = `${LOGIN_URL}/services/oauth2/token`;
  const params = new URLSearchParams();
  params.append('grant_type', 'password');
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  params.append('username', username);
  params.append('password', password);

  const response = await axios.post(url, params);
  return response.data;
}

function buildZip(triggerApiName, status) {
  const zip = new AdmZip();

  const triggerBody = `trigger ${triggerApiName} on Account (before insert) {
  // Dummy body
}`;

  const triggerMetaXml = `<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">
  <status>${status}</status>
  <apiVersion>64.0</apiVersion>
</ApexTrigger>`;

  const packageXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>${triggerApiName}</members>
    <name>ApexTrigger</name>
  </types>
  <version>64.0</version>
</Package>`;

  zip.addFile(`triggers/${triggerApiName}.trigger`, Buffer.from(triggerBody));
  zip.addFile(`triggers/${triggerApiName}.trigger-meta.xml`, Buffer.from(triggerMetaXml));
  zip.addFile('package.xml', Buffer.from(packageXml));

  return zip.toBuffer().toString('base64');
}

function buildSoapEnvelope(base64Zip) {
  return `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" 
              xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
              xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Body>
    <deploy xmlns="http://soap.sforce.com/2006/04/metadata">
      <ZipFile>${base64Zip}</ZipFile>
      <DeployOptions>
        <performRetrieve>false</performRetrieve>
        <rollbackOnError>true</rollbackOnError>
        <singlePackage>true</singlePackage>
      </DeployOptions>
    </deploy>
  </env:Body>
</env:Envelope>`;
}

app.post('/deploy-trigger', async (req, res) => {
  const { username, password, triggerApiName, active } = req.body;

  try {
    const auth = await authenticate(username, password);
    const sessionId = auth.access_token;
    const instanceUrl = auth.instance_url;

    const status = active ? 'Active' : 'Inactive';
    const base64Zip = buildZip(triggerApiName, status);
    const soapBody = buildSoapEnvelope(base64Zip);

    const deployRes = await axios.post(
      `${instanceUrl}/services/Soap/m/64.0`,
      soapBody,
      {
        headers: {
          'Content-Type': 'text/xml',
          'SOAPAction': '""',
          'Authorization': `Bearer ${sessionId}`,
        },
      }
    );

    res.send({ message: '✅ Deployment initiated.', response: deployRes.data });
  } catch (err) {
    console.error('❌ Error during deployment:', err.response?.data || err.message);
    res.status(500).send(err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
