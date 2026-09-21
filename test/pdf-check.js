const pdf = require('pdf-img-convert');
console.log('pdf-img-convert loaded successfully');
try {
    const convert = pdf.convert;
    if (typeof convert === 'function') {
        console.log('Conversion function available');
    } else {
        console.error('Conversion function missing');
    }
} catch (e) {
    console.error('Error checking library:', e);
}
