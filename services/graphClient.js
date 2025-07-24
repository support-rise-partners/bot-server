import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const GRAPH_API_URL = 'https://graph.microsoft.com/v1.0';

async function getAccessToken() {
const {
  TENANT_ID: AZURE_TENANT_ID,
  CLIENT_ID: AZURE_CLIENT_ID,
  CLIENT_SECRET: AZURE_CLIENT_SECRET
} = process.env;

  const url = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams();
  params.append('client_id', AZURE_CLIENT_ID);
  params.append('scope', 'https://graph.microsoft.com/.default');
  params.append('client_secret', AZURE_CLIENT_SECRET);
  params.append('grant_type', 'client_credentials');

  const response = await fetch(url, {
    method: 'POST',
    body: params
  });

  if (!response.ok) {
    throw new Error(`❌ Fehler beim Abrufen des Access Tokens: ${response.statusText}`);
  }

  const data = await response.json();
  return data.access_token;
}

export async function getUserDataById(aadObjectId) {
  try {
    const token = await getAccessToken();

    const response = await fetch(`${GRAPH_API_URL}/users/${aadObjectId}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`❌ Fehler beim Abrufen des Benutzers von Graph API: ${response.statusText}`);
    }

    const user = await response.json();
    return {
      displayName: user.displayName,
      email: user.mail || user.userPrincipalName // на всякий случай fallback
    };
  } catch (error) {
    console.error('❌ Fehler beim Abrufen des Benutzernamens von Graph API:', error.message);
    return { displayName: null, email: null };
  }
}

export async function getUserInfoByEmail(email) {
  try {
    const token = await getAccessToken();

    const response = await fetch(`${GRAPH_API_URL}/users/${email}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`❌ Fehler beim Abrufen des Benutzers per E-Mail: ${response.statusText}`);
    }

    const user = await response.json();
    return {
      displayName: user.displayName,
      email: user.mail || user.userPrincipalName,
      id: user.id
    };
  } catch (error) {
    console.error('❌ Fehler beim Abrufen des Benutzers per E-Mail:', error.message);
    return { displayName: null, email: null };
  }
}