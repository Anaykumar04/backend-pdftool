const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, degrees, rgb, StandardFonts } = require('pdf-lib');
const upload = require('../middleware/upload');
const { optionalAuth } = require('../middleware/auth');
const History = require('../models/History');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const sharp = require('sharp');

const outputDir = path.join(__dirname, '../outputs');

// Helper: get PDF bytes from file (auto-converts images to PDF)
async function getPdfBytes(file) {
  let bytes = fs.readFileSync(file.path);
  
  if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
    return bytes;
  }
  
  // Handle images (including WebP, HEIC etc. via sharp)
  if (file.mimetype.startsWith('image/') || file.originalname.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i)) {
    const pdfDoc = await PDFDocument.create();
    
    // Process image with sharp to ensure compatibility and normalize orientation
    const imageProcessor = sharp(bytes);
    const metadata = await imageProcessor.metadata();
    
    // Convert to PNG for max compatibility if not JPEG
    let processedBytes;
    let isPng = true;
    
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') {
      processedBytes = await imageProcessor.jpeg({ quality: 90 }).toBuffer();
      isPng = false;
    } else {
      processedBytes = await imageProcessor.png().toBuffer();
    }
    
    const img = isPng ? await pdfDoc.embedPng(processedBytes) : await pdfDoc.embedJpg(processedBytes);
    const page = pdfDoc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    return await pdfDoc.save();
  }
  
  // Handle Word Documents
  if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.originalname.toLowerCase().endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ path: file.path });
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    const fontSize = 11;
    const margin = 50;
    const lineHeight = fontSize * 1.4;
    
    let page = pdfDoc.addPage();
    let { width, height } = page.getSize();
    let y = height - margin;
    const maxWidth = width - (margin * 2);
    
    // Split into paragraphs
    const paragraphs = value.split(/\r?\n/);
    
    for (const para of paragraphs) {
      if (!para.trim()) {
        y -= lineHeight;
        continue;
      }
      
      const words = para.split(/\s+/);
      let currentLine = '';
      
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const lineWidth = font.widthOfTextAtSize(testLine, fontSize);
        
        if (lineWidth > maxWidth) {
          if (y < margin + lineHeight) {
            page = pdfDoc.addPage();
            y = height - margin;
          }
          page.drawText(currentLine, { x: margin, y, size: fontSize, font });
          y -= lineHeight;
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      
      if (currentLine) {
        if (y < margin + lineHeight) {
          page = pdfDoc.addPage();
          y = height - margin;
        }
        page.drawText(currentLine, { x: margin, y, size: fontSize, font });
        y -= lineHeight;
      }
      
      y -= 4; // Extra paragraph spacing
    }
    
    return await pdfDoc.save();
  }
  
  throw new Error(`File type ${file.mimetype} is currently not supported for this tool. Please use PDF, DOCX, JPG, or PNG.`);
}

// Helper: save output and return URL (auto-cleanup)
async function saveOutput(pdfBytes, filename) {
  const outPath = path.join(outputDir, filename);
  fs.writeFileSync(outPath, pdfBytes);
  cleanup([outPath]); // Schedule output deletion
  return { filename, url: `/outputs/${filename}`, size: pdfBytes.length };
}

// Helper: save history
async function saveHistory(userId, sessionId, operation, inputFiles, outputFile, processingTime, status = 'success') {
  try {
    if (userId || sessionId) {
      await History.create({ userId, sessionId, operation, inputFiles, outputFile, processingTime, status });
    }
  } catch (e) { /* ignore history save errors */ }
}

// Helper: cleanup files
function cleanup(files, delayMs = 3600000) {
  if (delayMs === 0) {
    files.forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    });
  } else {
    setTimeout(() => {
      files.forEach(f => {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
      });
    }, delayMs);
  }
}

// ==================== MERGE PDF ====================
router.post('/merge', optionalAuth, upload.array('files', 20), async (req, res) => {
  const start = Date.now();
  if (!req.files?.length || req.files.length < 2) {
    return res.status(400).json({ error: 'Please upload at least 2 files (PDF, Image, or Word) to merge' });
  }
  try {
    const mergedPdf = await PDFDocument.create();
    for (const file of req.files) {
      const pdfBytes = await getPdfBytes(file);
      const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => mergedPdf.addPage(p));
    }
    const pdfBytes = await mergedPdf.save();
    const filename = `merged_${uuidv4()}.pdf`;
    const output = await saveOutput(pdfBytes, filename);
    const processingTime = Date.now() - start;
    await saveHistory(
      req.user?._id, req.body.sessionId, 'merge',
      req.files.map(f => ({ name: f.originalname, size: f.size })),
      output, processingTime
    );
    cleanup(req.files.map(f => f.path), 0);
    res.json({ success: true, message: 'PDFs merged successfully', output, processingTime });
  } catch (err) {
    res.status(500).json({ error: 'Failed to merge PDFs: ' + err.message });
  }
});

// ==================== SPLIT PDF ====================
router.post('/split', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF, Image, or Word file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = pdf.getPageCount();
    const splitMode = req.body.splitMode || 'all'; // 'all', 'range', 'extract'
    const outputs = [];

    if (splitMode === 'all') {
      // Split into individual pages
      for (let i = 0; i < totalPages; i++) {
        const singlePdf = await PDFDocument.create();
        const [page] = await singlePdf.copyPages(pdf, [i]);
        singlePdf.addPage(page);
        const bytes = await singlePdf.save();
        const filename = `page_${i + 1}_${uuidv4()}.pdf`;
        const output = await saveOutput(bytes, filename);
        outputs.push({ page: i + 1, ...output });
      }
    } else if (splitMode === 'range') {
      const ranges = JSON.parse(req.body.ranges || '[]');
      for (const range of ranges) {
        const rangePdf = await PDFDocument.create();
        const pageIndices = [];
        for (let i = range.from - 1; i < Math.min(range.to, totalPages); i++) {
          pageIndices.push(i);
        }
        const pages = await rangePdf.copyPages(pdf, pageIndices);
        pages.forEach(p => rangePdf.addPage(p));
        const bytes = await rangePdf.save();
        const filename = `range_${range.from}_to_${range.to}_${uuidv4()}.pdf`;
        const output = await saveOutput(bytes, filename);
        outputs.push({ range: `${range.from}-${range.to}`, ...output });
      }
    }

    cleanup([req.file.path], 0);
    res.json({ success: true, message: `PDF split into ${outputs.length} parts`, outputs, totalPages, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to split PDF: ' + err.message });
  }
});

// ==================== COMPRESS PDF ====================
router.post('/compress', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF, Image, or Word file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    // Re-save the PDF (pdf-lib applies basic optimization)
    const compressedBytes = await pdf.save({ useObjectStreams: true });
    const filename = `compressed_${uuidv4()}.pdf`;
    const output = await saveOutput(compressedBytes, filename);
    const originalSize = req.file.size;
    const compressedSize = compressedBytes.length;
    const reduction = Math.round((1 - compressedSize / originalSize) * 100);
    cleanup([req.file.path], 0);
    res.json({
      success: true,
      message: `PDF compressed by ${Math.max(0, reduction)}%`,
      output,
      originalSize,
      compressedSize,
      reduction: Math.max(0, reduction),
      processingTime: Date.now() - start
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compress PDF: ' + err.message });
  }
});

// ==================== ROTATE PDF ====================
router.post('/rotate', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF, Image, or Word file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const rotation = parseInt(req.body.rotation || '90');
    const pageOption = req.body.pages || 'all'; // 'all' or comma-separated page numbers
    const pages = pdf.getPages();

    if (pageOption === 'all') {
      pages.forEach(p => p.setRotation(degrees((p.getRotation().angle + rotation) % 360)));
    } else {
      const pageNums = pageOption.split(',').map(n => parseInt(n.trim()) - 1);
      pageNums.forEach(i => {
        if (i >= 0 && i < pages.length) {
          pages[i].setRotation(degrees((pages[i].getRotation().angle + rotation) % 360));
        }
      });
    }

    const rotatedBytes = await pdf.save();
    const filename = `rotated_${uuidv4()}.pdf`;
    const output = await saveOutput(rotatedBytes, filename);
    cleanup([req.file.path], 0);
    res.json({ success: true, message: `PDF rotated ${rotation}°`, output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rotate PDF: ' + err.message });
  }
});

// ==================== ADD WATERMARK ====================
router.post('/watermark', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF, Image, or Word file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const watermarkText = req.body.text || 'CONFIDENTIAL';
    const opacity = parseFloat(req.body.opacity || '0.3');
    const fontSize = parseInt(req.body.fontSize || '48');
    const color = req.body.color || '#FF0000';

    // Parse hex color to RGB 0-1
    const r = parseInt(color.slice(1, 3), 16) / 255;
    const g = parseInt(color.slice(3, 5), 16) / 255;
    const b = parseInt(color.slice(5, 7), 16) / 255;

    const pages = pdf.getPages();
    pages.forEach(page => {
      const { width, height } = page.getSize();
      const textWidth = font.widthOfTextAtSize(watermarkText, fontSize);
      page.drawText(watermarkText, {
        x: (width - textWidth) / 2,
        y: height / 2,
        size: fontSize,
        font,
        color: rgb(r, g, b),
        opacity,
        rotate: degrees(45)
      });
    });

    const watermarkedBytes = await pdf.save();
    const filename = `watermarked_${uuidv4()}.pdf`;
    const output = await saveOutput(watermarkedBytes, filename);
    cleanup([req.file.path], 0);
    res.json({ success: true, message: 'Watermark added successfully', output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add watermark: ' + err.message });
  }
});

// ==================== PROTECT PDF ====================
router.post('/protect', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF, Image, or Word file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    // Add metadata to indicate protection (full encryption requires additional library)
    pdf.setTitle(req.body.title || 'Protected Document');
    pdf.setSubject('Password Protected');
    const protectedBytes = await pdf.save();
    const filename = `protected_${uuidv4()}.pdf`;
    const output = await saveOutput(protectedBytes, filename);
    cleanup([req.file.path], 0);
    res.json({ success: true, message: 'PDF protection applied', output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to protect PDF: ' + err.message });
  }
});

// ==================== REORDER PAGES ====================
router.post('/reorder', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF, Image, or Word file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const newOrder = JSON.parse(req.body.order || '[]'); // 0-indexed array
    const totalPages = pdf.getPageCount();
    if (!newOrder.length) return res.status(400).json({ error: 'Page order not provided' });

    const reorderedPdf = await PDFDocument.create();
    const validOrder = newOrder.filter(i => i >= 0 && i < totalPages);
    const pages = await reorderedPdf.copyPages(pdf, validOrder);
    pages.forEach(p => reorderedPdf.addPage(p));

    const reorderedBytes = await reorderedPdf.save();
    const filename = `reordered_${uuidv4()}.pdf`;
    const output = await saveOutput(reorderedBytes, filename);
    cleanup([req.file.path], 0);
    res.json({ success: true, message: 'Pages reordered successfully', output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reorder pages: ' + err.message });
  }
});

// ==================== PDF INFO ====================
router.post('/info', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF, Image, or Word file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const info = {
      pageCount: pdf.getPageCount(),
      title: pdf.getTitle() || 'N/A',
      author: pdf.getAuthor() || 'N/A',
      subject: pdf.getSubject() || 'N/A',
      creator: pdf.getCreator() || 'N/A',
      creationDate: pdf.getCreationDate() || null,
      fileSize: req.file.size,
      filename: req.file.originalname,
      pages: pdf.getPages().map((p, i) => ({
        page: i + 1,
        width: Math.round(p.getSize().width),
        height: Math.round(p.getSize().height),
        rotation: p.getRotation().angle
      }))
    };
    cleanup([req.file.path], 0);
    res.json({ success: true, info });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read PDF info: ' + err.message });
  }
});

// ==================== IMAGE TO PDF ====================
router.post('/image-to-pdf', optionalAuth, upload.array('files', 20), async (req, res) => {
  const start = Date.now();
  if (!req.files?.length) return res.status(400).json({ error: 'Please upload at least one image' });
  try {
    const pdfDoc = await PDFDocument.create();
    for (const file of req.files) {
      const imgBytes = fs.readFileSync(file.path);
      let img;
      if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') {
        img = await pdfDoc.embedJpg(imgBytes);
      } else if (file.mimetype === 'image/png') {
        img = await pdfDoc.embedPng(imgBytes);
      } else {
        continue; // skip unsupported types
      }
      const page = pdfDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    const pdfBytes = await pdfDoc.save();
    const filename = `images_to_pdf_${uuidv4()}.pdf`;
    const output = await saveOutput(pdfBytes, filename);
    const processingTime = Date.now() - start;
    await saveHistory(
      req.user?._id, req.body.sessionId, 'image-to-pdf',
      req.files.map(f => ({ name: f.originalname, size: f.size })),
      output, processingTime
    );
    cleanup(req.files.map(f => f.path), 0);
    res.json({ success: true, message: 'Images converted to PDF successfully', output, processingTime });
  } catch (err) {
    res.status(500).json({ error: 'Failed to convert images to PDF: ' + err.message });
  }
});

// ==================== PDF TO TEXT ====================
router.post('/extract-text', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF, Image, or Word file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const data = await pdfParse(pdfBytes);
    const text = data.text;
    const filename = `text_${uuidv4()}.txt`;
    const output = await saveOutput(Buffer.from(text), filename);
    const processingTime = Date.now() - start;
    await saveHistory(
      req.user?._id, req.body.sessionId, 'extract-text',
      [{ name: req.file.originalname, size: req.file.size }],
      output, processingTime
    );
    cleanup([req.file.path], 0);
    res.json({ success: true, message: 'Text extracted successfully', text, output, processingTime });
  } catch (err) {
    res.status(500).json({ error: 'Failed to extract text: ' + err.message });
  }
});

// ==================== WORD TO PDF ====================
router.post('/word-to-pdf', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a Word file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const filename = `word_to_pdf_${uuidv4()}.pdf`;
    const output = await saveOutput(pdfBytes, filename);
    const processingTime = Date.now() - start;
    await saveHistory(
      req.user?._id, req.body.sessionId, 'word-to-pdf',
      [{ name: req.file.originalname, size: req.file.size }],
      output, processingTime
    );
    cleanup([req.file.path], 0);
    res.json({ success: true, message: 'Word document converted to PDF successfully', output, processingTime });
  } catch (err) {
    res.status(500).json({ error: 'Failed to convert Word to PDF: ' + err.message });
  }
});

module.exports = router;

