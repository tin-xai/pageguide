const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '../manifest.json');

try {
  if (!fs.existsSync(manifestPath)) {
    console.error('Error: manifest.json not found!');
    process.exit(1);
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestContent);

  // Basic checks
  const requiredFields = ['manifest_version', 'name', 'version'];
  const missingFields = requiredFields.filter(field => !manifest[field]);

  if (missingFields.length > 0) {
    console.error(`Error: Missing required fields in manifest.json: ${missingFields.join(', ')}`);
    process.exit(1);
  }

  console.log('Success: manifest.json is valid JSON and contains required fields.');

} catch (error) {
  console.error('Error parsing manifest.json:', error.message);
  process.exit(1);
}
