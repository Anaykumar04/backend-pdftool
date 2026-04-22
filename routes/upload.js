const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('../utils/cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { protect } = require('../middleware/auth');

// Multer storage for Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    // Determine resource_type
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

const upload = multer({ storage: storage });

// Upload File
router.post('/file', protect, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Multer/Cloudinary Error:', err);
      return res.status(500).json({ error: 'Upload to Cloudinary failed. Please check your credentials.', details: err.message });
    }
    
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    res.json({
      success: true,
      secure_url: req.file.path,
      public_id: req.file.filename,
      resource_type: req.file.resource_type || 'auto'
    });
  });
});

// Upload via URL
router.post('/url', protect, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    // Determine if it's a PDF/Doc to set resource_type: 'raw'
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

module.exports = router;
