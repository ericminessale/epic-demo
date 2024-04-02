// Load libraries and configure variables
var express = require('express');
var fs = require('fs');
var uuid = require('uuid');
const qs = require('qs');
var axios = require('axios');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser'); // Import body-parser

// Initialize Express app
var app = express();
var port = process.env.PORT || 3000;

// Configure service name and key path
var serviceName = '79f0b402-2b13-4e8b-838e-38774413a552';
var privateKeyPath = 'keys/private.pem';

// Load private key from file
var serviceKey;
try {
  serviceKey = fs.readFileSync(privateKeyPath, 'utf8');
} catch (err) {
  console.error('Error loading private key:', err);
  process.exit(1); // Exit the process if key loading fails
}

// Use body-parser middleware to parse JSON data
app.use(bodyParser.json());

// Start the Express server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Utility function to create expiration date
function createExpirationDate() {
  var t = Date.now();
  t += 1000 * 60 * 5; // 5 minutes
  return Math.round(t / 1000);
}

// Define a POST route to trigger the FHIR request and generate JWT
app.post('/', function(req, res) {
  const { patient_first_name, patient_last_name, patient_birthdate } = req.body; // Now req.body should be defined

  // Log the received data
  console.log('Received data:', req.body);

  // Construct JWT claims
  var myUUID = uuid.v4();
  var payloadClaims = {
    "iss": serviceName,
    "sub": serviceName,
    "aud": "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
    'jti': myUUID,
    "exp": createExpirationDate()
  };

  // Sign the JWT using jsonwebtoken
  var token = jwt.sign(payloadClaims, serviceKey, { algorithm: 'RS384' });

  // Build Axios config for FHIR endpoint
  let data = qs.stringify({
    'grant_type': 'client_credentials',
    'client_assertion_type': 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    'client_assertion': token
  });

  let config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
    headers: { 
      'Accept': 'application/json', 
      'Content-Type': 'application/x-www-form-urlencoded', 
      'api-version': '1'
    },
    data: data
  };

  // Trigger FHIR request using Axios
  axios.request(config)
    .then((response) => {
      const accessToken = response.data.access_token;

      const fhirUrl = `https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/Patient?family=${patient_last_name}&given=${patient_first_name}&birthdate=${patient_birthdate}`;

      axios.get(fhirUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/fhir+json',
          Accept: 'application/json'
        }
      })
        .then((fhirResponse) => {
          const patientResource = fhirResponse.data.entry[0].resource;

          const patientData = {
            id: patientResource.id,
            name: `${patientResource.name[0].given[0]} ${patientResource.name[0].family}`,
            gender: patientResource.gender,
            birthDate: patientResource.birthDate,
            address: patientResource.address[0].line.join(', ')
          };

          console.log('Patient Data:', patientData); // Log the patient data

          // Now fetch appointments for the patient
          const appointmentUrl = `https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/Appointment?patient=${patientData.id}`;

          axios.get(appointmentUrl, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/fhir+json',
              Accept: 'application/json'
            }
          })
            .then((appointmentResponse) => {
              const appointments = appointmentResponse.data.entry.map(entry => entry.resource);
              console.log('Appointments:', appointments); // Log the appointments
              
              // Extract specific appointment data
              const appointmentData = appointments.map(appointment => ({
                id: appointment.id,
                date: appointment.start,
                status: appointment.status,
                // Add more properties as needed
              }));

              // Add appointmentData to patientData
              patientData.appointments = appointmentData;

              res.status(200).json(patientData); // Send the patient data with appointments back as the response
            })
            .catch((error) => {
              console.error('Error fetching appointments:', error);
              res.status(500).send('Error fetching appointments');
            });
        })
        .catch((error) => {
          console.log('Error performing FHIR search:', error); // Log the error
          res.status(500).send('Error performing FHIR search');
        });
    })
    .catch((error) => {
      console.log('Error triggering FHIR request:', error);
      res.status(500).send('Error triggering FHIR request');
    });
});