require('dotenv').config();
const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const API_VERSION = '59.0';

app.post('/api/toggle-trigger', async (req, res) => {
  const { username, password, triggerApiName, status } = req.body;

  try {
    // Step 1: Login
    const loginResponse = await axios.post(
      `${process.env.LOGIN_URL}/services/Soap/u/${API_VERSION}`,
      `
        <env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" 
                      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
                      xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
          <env:Body>
            <n1:login xmlns:n1="urn:partner.soap.sforce.com">
              <n1:username>${username}</n1:username>
              <n1:password>${password}</n1:password>
            </n1:login>
          </env:Body>
        </env:Envelope>
      `,
      {
        headers: {
          'Content-Type': 'text/xml',
          SOAPAction: 'login',
        },
      }
    );

    const sessionId = loginResponse.data.match(/<sessionId>(.+?)<\/sessionId>/)[1];
    const serverUrl = loginResponse.data.match(/<serverUrl>(.+?)<\/serverUrl>/)[1];
    const instanceUrl = new URL(serverUrl).origin;

    // Step 2: Retrieve the .trigger-meta.xml
    const retrieveBody = `
      <env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
        <env:Header>
          <SessionHeader xmlns="http://soap.sforce.com/2006/04/metadata">
            <sessionId>${sessionId}</sessionId>
          </SessionHeader>
        </env:Header>
        <env:Body>
          <retrieve xmlns="http://soap.sforce.com/2006/04/metadata">
            <retrieveRequest>
              <apiVersion>${API_VERSION}</apiVersion>
              <singlePackage>true</singlePackage>
              <unpackaged>
                <types>
                  <members>${triggerApiName}</members>
                  <name>ApexTrigger</name>
                </types>
                <version>${API_VERSION}</version>
              </unpackaged>
            </retrieveRequest>
          </retrieve>
        </env:Body>
      </env:Envelope>
    `;

    const retrieveResponse = await axios.post(
      `${instanceUrl}/services/Soap/m/${API_VERSION}`,
      retrieveBody,
      {
        headers: {
          'Content-Type': 'text/xml',
        },
      }
    );

    const retrieveId = retrieveResponse.data.match(/<id>(.+?)<\/id>/)[1];

    // Step 3: Wait for retrieve result
    let retrieveDone = false;
    let zipBase64 = null;

    while (!retrieveDone) {
      const checkBody = `
        <env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
          <env:Header>
            <SessionHeader xmlns="http://soap.sforce.com/2006/04/metadata">
              <sessionId>${sessionId}</sessionId>
            </SessionHeader>
          </env:Header>
          <env:Body>
            <checkRetrieveStatus xmlns="http://soap.sforce.com/2006/04/metadata">
              <id>${retrieveId}</id>
              <includeZip>true</includeZip>
            </checkRetrieveStatus>
          </env:Body>
        </env:Envelope>
      `;

      const checkResponse = await axios.post(
        `${instanceUrl}/services/Soap/m/${API_VERSION}`,
        checkBody,
        {
          headers: {
            'Content-Type': 'text/xml',
          },
        }
      );

      const doneMatch = checkResponse.data.match(/<done>(.+?)<\/done>/);
      if (doneMatch && doneMatch[1] === 'true') {
        retrieveDone = true;
        zipBase64 = checkResponse.data.match(/<zipFile>([\s\S]+?)<\/zipFile>/)[1];
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Step 4: Modify the status in the .trigger-meta.xml
    const zipBuffer = Buffer.from(zipBase64, 'base64');
    const zip = new AdmZip(zipBuffer);
    const triggerMetaEntry = zip.getEntry(`triggers/${triggerApiName}.trigger-meta.xml`);

    if (!triggerMetaEntry) {
      throw new Error('Trigger metadata not found in ZIP');
    }

    const originalMetaXml = triggerMetaEntry.getData().toString('utf-8');
    const parser = new xml2js.Parser();
    const builder = new xml2js.Builder({ headless: true });

    const parsedXml = await parser.parseStringPromise(originalMetaXml);
    parsedXml.ApexTrigger.status = [status];

    const updatedMetaXml = builder.buildObject(parsedXml);

    zip.updateFile(`triggers/${triggerApiName}.trigger-meta.xml`, Buffer.from(updatedMetaXml, 'utf-8'));

    // Step 5: Deploy the updated metadata
    const deployBody = `
      <env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
        <env:Header>
          <SessionHeader xmlns="http://soap.sforce.com/2006/04/metadata">
            <sessionId>${sessionId}</sessionId>
          </SessionHeader>
        </env:Header>
        <env:Body>
          <deploy xmlns="http://soap.sforce.com/2006/04/metadata">
            <ZipFile>${zip.toBuffer().toString('base64')}</ZipFile>
            <DeployOptions>
              <rollbackOnError>true</rollbackOnError>
            </DeployOptions>
          </deploy>
        </env:Body>
      </env:Envelope>
    `;

    const deployResponse = await axios.post(
      `${instanceUrl}/services/Soap/m/${API_VERSION}`,
      deployBody,
      {
        headers: {
          'Content-Type': 'text/xml',
        },
      }
    );

    const deployId = deployResponse.data.match(/<id>(.+?)<\/id>/)[1];

    // Step 6: Wait for deployment to complete
    let deployDone = false;
    let deployFinalResponse = '';

    while (!deployDone) {
      const checkDeployBody = `
        <env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
          <env:Header>
            <SessionHeader xmlns="http://soap.sforce.com/2006/04/metadata">
              <sessionId>${sessionId}</sessionId>
            </SessionHeader>
          </env:Header>
          <env:Body>
            <checkDeployStatus xmlns="http://soap.sforce.com/2006/04/metadata">
              <id>${deployId}</id>
              <includeDetails>true</includeDetails>
            </checkDeployStatus>
          </env:Body>
        </env:Envelope>
      `;

      const checkDeployResponse = await axios.post(
        `${instanceUrl}/services/Soap/m/${API_VERSION}`,
        checkDeployBody,
        {
          headers: {
            'Content-Type': 'text/xml',
          },
        }
      );

      deployFinalResponse = checkDeployResponse.data;
      const doneMatch = deployFinalResponse.match(/<done>(.+?)<\/done>/);
      if (doneMatch && doneMatch[1] === 'true') {
        deployDone = true;
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    res.send({ success: true, response: deployFinalResponse });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).send({ error: error.message || 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
