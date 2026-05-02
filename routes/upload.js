const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('../utils/cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { protect, verifiedOnly } = require('../middleware/auth');

const isCloudinaryConfigured = process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_KEY !== 'your_api_key';

// Local storage for fallback
const localStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadsDir = process.env.NODE_ENV === 'production' 
      ? '/tmp/uploads' 
      : 'uploads';
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

// Multer storage for Cloudinary
const cloudStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    let resource_type = 'auto';
    if (file.mimetype === 'application/pdf' || file.mimetype.includes('word') || file.mimetype.includes('document')) {
      resource_type = 'raw';
    }
    return {
      folder: 'pdf-toolkit',
      resource_type: resource_type,
      public_id: `${Date.now()}-${file.originalname.split('.')[0]}`,
      format: file.originalname.split('.').pop()
    };
  },
});

const uploadCloud = multer({ storage: cloudStorage });
const uploadLocal = multer({ storage: localStorage });

const { getBaseUrl } = require('../utils/helpers');

// Upload File
router.post('/file', protect, verifiedOnly, (req, res) => {
  const upload = isCloudinaryConfigured ? uploadCloud.single('file') : uploadLocal.single('file');
  
  upload(req, res, (err) => {
    if (err) {
      console.error('Upload Error:', err);
      return res.status(500).json({ 
        error: 'Upload failed', 
        details: err.message,
        suggestion: 'Check server logs or Cloudinary configuration'
      });
    }
    
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    let fileUrl;
    if (isCloudinaryConfigured) {
      fileUrl = req.file.path;
    } else {
      const baseUrl = getBaseUrl(req);
      fileUrl = `${baseUrl}/uploads/${req.file.filename}`;
    }
    
    res.json({
      success: true,
      secure_url: fileUrl,
      public_id: req.file.filename || req.file.public_id,
      resource_type: req.file.resource_type || 'auto'
    });
  });
});

// Upload via URL
router.post('/url', protect, verifiedOnly, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    if (!isCloudinaryConfigured) {
      // If no Cloudinary, just return the original URL as "uploaded" URL if it's already a public URL
      // or implement a downloader if needed. For now, let's keep it simple.
      return res.json({
        success: true,
        secure_url: url,
        public_id: 'external-url',
        resource_type: 'auto'
      });
    }

    let resource_type = 'auto';
    if (url.toLowerCase().endsWith('.pdf') || url.toLowerCase().endsWith('.docx') || url.toLowerCase().endsWith('.doc')) {
      resource_type = 'raw';
    }

    const result = await cloudinary.uploader.upload(url, {
      folder: 'pdf-toolkit',
      resource_type: resource_type
    });

    res.json({
      success: true,
      secure_url: result.secure_url,
      public_id: result.public_id,
      resource_type: result.resource_type
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download File via Proxy
router.get('/download/:public_id', async (req, res) => {
  try {
    const publicId = req.params.public_id;
    if (!publicId) return res.status(400).send('Public ID is required');

    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      return res.status(404).send('Cloudinary not configured');
    }

    // Determine if it has extension (like .pdf)
    const hasExtension = publicId.includes('.');
    const filename = hasExtension ? publicId : `${publicId}.pdf`; // Assume PDF if no extension

    // Cloudinary raw URL format for pdf-toolkit folder
    const cloudinaryUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload/pdf-toolkit/${publicId}`;
    
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(cloudinaryUrl);
    
    if (!response.ok) {
      // Try image upload URL if raw fails
      const imageUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/fl_attachment/pdf-toolkit/${publicId}`;
      return res.redirect(imageUrl);
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Content-Length', response.headers.get('content-length'));

    response.body.pipe(res);
  } catch (err) {
    res.status(500).send('Error downloading file');
  }
});

module.exports = router;
