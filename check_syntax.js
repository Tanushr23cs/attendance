const fs = require('fs');
const code = fs.readFileSync('frontend/script.js', 'utf8');
try {
    new Function(code);
    console.log('No syntax error');
} catch (e) {
    console.error(e);
}
