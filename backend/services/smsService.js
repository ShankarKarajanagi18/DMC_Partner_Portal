const axios = require('axios');

async function sendRealSmsOtp(phoneNumber, otpCode) {
  const cleanPhone = phoneNumber.trim().replace(/[\s\-()]/g, '');
  const messageText = `Your Plan & Trip DMC verification code is: ${otpCode}. Valid for 10 minutes.`;
  
  let result = {
    success: false,
    provider: null,
    messageId: null,
    error: null
  };

  // 1. Twilio (Global)
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const msg = await client.messages.create({
        body: messageText,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: cleanPhone
      });
      return { success: true, provider: 'Twilio SMS', messageId: msg.sid };
    } catch (err) {
      result.error = err.message;
    }
  }

  // 2. Fast2SMS (India +91)
  if (process.env.FAST2SMS_API_KEY) {
    try {
      const rawNumber = cleanPhone.replace(/[^0-9]/g, '').slice(-10);
      const response = await axios.post('https://www.fast2sms.com/dev/bulkV2', {
        route: 'otp',
        variables_values: otpCode,
        numbers: rawNumber
      }, {
        headers: { 
          'authorization': process.env.FAST2SMS_API_KEY.trim(),
          'Content-Type': 'application/json'
        }
      });

      if (response.data && (response.data.return || response.data.status_code === 200)) {
        return { success: true, provider: 'Fast2SMS', messageId: response.data.request_id || 'OK' };
      } else {
        result.error = response.data ? (response.data.message || JSON.stringify(response.data)) : 'Fast2SMS Error';
      }
    } catch (err) {
      result.error = err.response ? JSON.stringify(err.response.data) : err.message;
    }
  }

  return result;
}

module.exports = { sendRealSmsOtp };
