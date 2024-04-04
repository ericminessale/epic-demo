var express = require('express');
var fs = require('fs');
var uuid = require('uuid');
const qs = require('qs');
var axios = require('axios');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');

// Initialize Express
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
  process.exit(1);
}

app.use(bodyParser.json());

// Start the Express server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

function createExpirationDate() {
  var t = Date.now();
  t += 1000 * 60 * 5; // 5 minutes
  return Math.round(t / 1000);
}

// POST route
app.post('/', function(req, res) {
  const { patient_first_name, patient_last_name, patient_birthdate, address, telecom } = req.body;

  // Received data debug log
  console.log('Received data:', {
    patient_first_name,
    patient_last_name,
    patient_birthdate,
    address,
    telecom
  });

  var myUUID = uuid.v4();
  var payloadClaims = {
    "iss": serviceName,
    "sub": serviceName,
    "aud": "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
    'jti': myUUID,
    "exp": createExpirationDate()
  };

  // Sign JWT
  var token = jwt.sign(payloadClaims, serviceKey, { algorithm: 'RS384' });

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

  // FHIR request
  axios.request(config)
    .then((response) => {
      const accessToken = response.data.access_token;

      let fhirUrl = `https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/Patient?`;
      if (patient_last_name) fhirUrl += `family=${patient_last_name}&`;
      if (patient_first_name) fhirUrl += `given=${patient_first_name}&`;
      if (patient_birthdate) fhirUrl += `birthdate=${patient_birthdate}&`;
      if (address) fhirUrl += `address=${address}&`;
      if (telecom) fhirUrl += `telecom=${telecom}&`;

      axios.get(fhirUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/fhir+json',
          Accept: 'application/json'
        }
      })
        .then((fhirResponse) => {
          if (fhirResponse.data && fhirResponse.data.entry && fhirResponse.data.entry.length > 0) {
            const patientResource = fhirResponse.data.entry[0].resource;

            const patientData = {
              id: patientResource.id,
              name: `${patientResource.name[0].given[0]} ${patientResource.name[0].family}`,
              gender: patientResource.gender,
              birthDate: patientResource.birthDate,
              address: patientResource.address[0].line.join(', ')
            };

            console.log('Patient Data:', patientData);

            // get appointments
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
              console.log('Appointments:', appointments);
              
              const appointmentData = appointments.map(appointment => ({
                id: appointment.id,
                date: appointment.start,
                status: appointment.status,
              }));

              // Add appointments to patient data
              patientData.appointments = appointmentData;

              res.status(200).json(patientData); // Send the patient data and appointments
            })
            .catch((error) => {
              console.error('Error fetching appointments:', error);
              res.status(500).send('Error fetching appointments');
            });
          } else {
            console.log('Patient not found or no data returned.');
            res.status(404).json({ error: 'Patient not found or no data returned.' });
          }
        })
        .catch((error) => {
          console.log('Error performing FHIR search:', error); 
          res.status(500).send('Error performing FHIR search');
        });
    })
    .catch((error) => {
      console.log('Error triggering FHIR request:', error);
      res.status(500).send('Error triggering FHIR request');
    });
});
