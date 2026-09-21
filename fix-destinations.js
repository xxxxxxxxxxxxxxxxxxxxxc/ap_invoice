const axios = require("axios");

const destCredentials = {
  url: "https://finance-documentai-dev2.authentication.eu20.hana.ondemand.com",
  clientid: "sb-clone7df254fe73be43acb84c7f808f091b07!b139466|destination-xsappname!b2",
  clientsecret: "442e4575-6171-4b29-9605-b9de33a215bd$oiijnTFAvK0oTS7Hk40Cbii3pGyPHE-DI8Sd7mCX3Cg=",
  uri: "https://destination-configuration.cfapps.eu20.hana.ondemand.com"
};

async function fixDestinations() {
  try {
    console.log("1. Fetching XSUAA token for Destination Service...");
    const tokenOptions = {
      method: "POST",
      url: `${destCredentials.url}/oauth/token?grant_type=client_credentials`,
      headers: {
        Authorization: "Basic " + Buffer.from(`${destCredentials.clientid}:${destCredentials.clientsecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      }
    };
    
    const tokenResponse = await axios(tokenOptions);
    const token = tokenResponse.data.access_token;

    console.log("2. Fetching Subaccount Destinations...");
    const destGetResponse = await axios({
      method: "GET",
      url: `${destCredentials.uri}/destination-configuration/v1/subaccountDestinations`,
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const destinations = destGetResponse.data.map(d => d.Name);
    console.log(`Found ${destinations.length} destinations: ` + destinations.join(", "));

    const targets = destinations.filter(d => d.startsWith("AP_Invoice-"));
    console.log(`Found ${targets.length} target destinations to delete: ` + targets.join(", "));

    for (const d of targets) {
      console.log(`Deleting destination: ${d}...`);
      await axios({
        method: "DELETE",
        url: `${destCredentials.uri}/destination-configuration/v1/subaccountDestinations/${d}`,
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      console.log(`Deleted ${d} successfully!`);
    }

    console.log("All broken destinations purged. Now we can safely redeploy.");

  } catch (err) {
    console.error("Error occurred:", err.response ? err.response.data : err.message);
  }
}

fixDestinations();
