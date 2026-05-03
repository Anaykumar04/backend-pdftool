let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  console.warn('⚠️  nodemailer not installed - OTP emails will be logged to console only');
}

const createTransporter = () => {
  if (!nodemailer) return null;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
};

const sendOTPEmail = async (email, otp, name) => {
  // Always log OTP to console as fallback (useful for dev/testing)
  console.log(`📧 OTP for ${email}: ${otp}`);

  const transporter = createTransporter();
  if (!transporter) {
    console.warn('⚠️  Email not configured - OTP logged to console only');
    return;
  }

  const mailOptions = {
    from: `"PDFtoolkit" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Verify your PDFtoolkit account',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #f9fafb; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #7c3aed; font-size: 24px; margin: 0;">📄 PDFtoolkit</h1>
        </div>
        <div style="background: white; padding: 32px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <h2 style="color: #111827; margin-top: 0;">Hi ${name || 'there'} 👋</h2>
          <p style="color: #6b7280;">Use the code below to verify your email address. This code expires in <strong>10 minutes</strong>.</p>
          <div style="text-align: center; margin: 32px 0;">
            <span style="font-size: 40px; font-weight: 700; letter-spacing: 12px; color: #7c3aed; background: #f3f0ff; padding: 16px 24px; border-radius: 8px;">${otp}</span>
          </div>
          <p style="color: #9ca3af; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

module.exports = { sendOTPEmail };

