require('dotenv').config();
const express = require('express');
const axios = require('axios');
const JSZip = require('jszip');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

app.post('/api/toggle-trigger', async (req, res) => {
  const { username, password, securityToken, triggerApiName, status } = req.body;

  if (!username || !password || !securityToken || !triggerApiName || !status) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    // STEP 1: Authenticate
    const tokenRes = await axios.post(`${process.env.LOGIN_URL}/services/oauth2/token`, null, {
      params: {
        grant_type: 'password',
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        username,
        password: password + securityToken
      }
    });

    const { access_token, instance_url } = tokenRes.data;

    // STEP 2: Create trigger metadata and package.xml
    const zip = new JSZip();

    const triggerXml = `<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">
  <status>${status.toLowerCase() === 'on' ? 'Active' : 'Inactive'}</status>
</ApexTrigger>`;

    const packageXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>${triggerApiName}</members>
    <name>ApexTrigger</name>
  </types>
  <version>58.0</version>
</Package>`;

    zip.file(`triggers/${triggerApiName}.trigger-meta.xml`, triggerXml);
    zip.file('package.xml', packageXml);
    const zipBase64 = await zip.generateAsync({ type: 'base64' });

    // STEP 3: Deploy using Metadata SOAP
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
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
          'SOAPAction': '""',
          'Authorization': `Bearer ${access_token}`
        }
      }
    );

    return res.status(200).send({ message: 'Trigger deployment requested.', response: deployRes.data });

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Something went wrong', details: error.response?.data || error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
