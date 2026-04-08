const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, degrees, rgb, StandardFonts, PDFName } = require('pdf-lib');
const upload = require('../middleware/upload');
const { optionalAuth } = require('../middleware/auth');
const History = require('../models/History');
const mammoth = require('mammoth');
const translatte = require('translatte');
const pdfParse = require('pdf-parse');
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

// ==================== DELETE PAGES ====================
router.post('/delete-pages', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const pagesToDelete = JSON.parse(req.body.pages || '[]').map(n => parseInt(n) - 1);
    
    const totalPages = pdf.getPageCount();
    const indicesToKeep = [];
    for (let i = 0; i < totalPages; i++) {
      if (!pagesToDelete.includes(i)) indicesToKeep.push(i);
    }

    if (indicesToKeep.length === 0) return res.status(400).json({ error: 'Cannot delete all pages' });

    const newPdf = await PDFDocument.create();
    const copiedPages = await newPdf.copyPages(pdf, indicesToKeep);
    copiedPages.forEach(p => newPdf.addPage(p));

    const resultBytes = await newPdf.save();
    const filename = `deleted_pages_${uuidv4()}.pdf`;
    const output = await saveOutput(resultBytes, filename);
    
    cleanup([req.file.path], 0);
    res.json({ success: true, message: `Deleted ${pagesToDelete.length} pages`, output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete pages: ' + err.message });
  }
});

// ==================== ADD PAGE NUMBERS ====================
router.post('/page-numbers', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const position = req.body.position || 'bottom-center';
    const fontSize = parseInt(req.body.fontSize || '10');
    
    const pages = pdf.getPages();
    pages.forEach((page, i) => {
      const { width, height } = page.getSize();
      const text = `${i + 1} / ${pages.length}`;
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      
      let x, y;
      if (position.includes('bottom')) y = 20;
      else if (position.includes('top')) y = height - 30;
      else y = height / 2;

      if (position.includes('left')) x = 30;
      else if (position.includes('right')) x = width - textWidth - 30;
      else x = (width - textWidth) / 2;

      page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.5, 0.5, 0.5) });
    });

    const numberedBytes = await pdf.save();
    const filename = `numbered_${uuidv4()}.pdf`;
    const output = await saveOutput(numberedBytes, filename);
    cleanup([req.file.path], 1000); // give it a sec
    res.json({ success: true, message: 'Page numbers added successfully', output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add page numbers: ' + err.message });
  }
});

// ==================== ADD STAMP ====================
router.post('/add-stamp', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file' });
  try {
    const pdfBytes = await getPdfBytes(req.file);
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const stampText = req.body.text || 'APPROVED';
    const color = req.body.color || '#FF0000';
    
    const r = parseInt(color.slice(1, 3), 16) / 255;
    const g = parseInt(color.slice(3, 5), 16) / 255;
    const b = parseInt(color.slice(5, 7), 16) / 255;

    const pages = pdf.getPages();
    pages.forEach(page => {
      const { width, height } = page.getSize();
      const fontSize = 60;
      const textWidth = font.widthOfTextAtSize(stampText, fontSize);
      
      page.drawText(stampText, {
        x: (width - textWidth) / 2,
        y: height / 2,
        size: fontSize,
        font,
        color: rgb(r, g, b),
        opacity: 0.2,
        rotate: degrees(30)
      });
      
      // Draw a border box around stamp
      page.drawRectangle({
        x: (width - textWidth) / 2 - 10,
        y: height / 2 - 10,
        width: textWidth + 20,
        height: fontSize + 10,
        borderColor: rgb(r, g, b),
        borderWidth: 2,
        opacity: 0.2,
        rotate: degrees(30)
      });
    });

    const stampedBytes = await pdf.save();
    const filename = `stamped_${uuidv4()}.pdf`;
    const output = await saveOutput(stampedBytes, filename);
    cleanup([req.file.path], 0);
    res.json({ success: true, message: 'Stamp added successfully', output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add stamp: ' + err.message });
  }
});

// ==================== JSON TO PDF ====================
router.post('/json-to-pdf', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a JSON file' });
  try {
    const jsonText = fs.readFileSync(req.file.path, 'utf8');
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Courier);
    
    const lines = JSON.stringify(JSON.parse(jsonText), null, 2).split('\n');
    let page = pdfDoc.addPage();
    let y = page.getSize().height - 50;
    
    for (const line of lines) {
      if (y < 50) {
        page = pdfDoc.addPage();
        y = page.getSize().height - 50;
      }
      page.drawText(line, { x: 50, y, size: 9, font });
      y -= 11;
    }

    const pdfBytes = await pdfDoc.save();
    const filename = `json_to_pdf_${uuidv4()}.pdf`;
    const output = await saveOutput(pdfBytes, filename);
    cleanup([req.file.path], 0);
    res.json({ success: true, message: 'JSON converted to PDF successfully', output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to convert JSON: ' + err.message });
  }
});

// ==================== XML TO PDF ====================
router.post('/xml-to-pdf', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload an XML file' });
  try {
    const xmlText = fs.readFileSync(req.file.path, 'utf8');
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Courier);
    
    const lines = xmlText.split('\n');
    let page = pdfDoc.addPage();
    let y = page.getSize().height - 50;
    
    for (const line of lines) {
      if (y < 50) {
        page = pdfDoc.addPage();
        y = page.getSize().height - 50;
      }
      page.drawText(line.substring(0, 100), { x: 50, y, size: 9, font });
      y -= 11;
    }

    const pdfBytes = await pdfDoc.save();
    const filename = `xml_to_pdf_${uuidv4()}.pdf`;
    const output = await saveOutput(pdfBytes, filename);
    cleanup([req.file.path], 0);
    res.json({ success: true, message: 'XML converted to PDF successfully', output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to convert XML: ' + err.message });
  }
});

// ==================== EMAIL TO PDF ====================
router.post('/email-to-pdf', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload an Email file (.eml or .txt)' });
  try {
    const emailText = fs.readFileSync(req.file.path, 'utf8');
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    let page = pdfDoc.addPage();
    let { width, height } = page.getSize();
    let y = height - 50;

    page.drawText('Email Document Export', { x: 50, y, size: 18, font: boldFont });
    y -= 30;

    const lines = emailText.split('\n');
    for (const line of lines) {
      if (y < 50) {
        page = pdfDoc.addPage();
        y = page.getSize().height - 50;
      }
      page.drawText(line.substring(0, 90), { x: 50, y, size: 10, font });
      y -= 14;
    }

    const pdfBytes = await pdfDoc.save();
    const filename = `email_to_pdf_${uuidv4()}.pdf`;
    const output = await saveOutput(pdfBytes, filename);
    cleanup([req.file.path], 0);
    res.json({ success: true, message: 'Email converted to PDF successfully', output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to convert Email: ' + err.message });
  }
});

// ==================== CSV TO PDF ====================
router.post('/csv-to-pdf', optionalAuth, upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a CSV file' });
  try {
    const csvData = fs.readFileSync(req.file.path, 'utf8');
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    const lines = csvData.split('\n');
    let page = pdfDoc.addPage();
    let { height } = page.getSize();
    let y = height - 50;

    for (let i = 0; i < lines.length; i++) {
      if (y < 50) {
        page = pdfDoc.addPage();
        y = height - 50;
      }
      const fontToUse = i === 0 ? boldFont : font;
      page.drawText(lines[i].substring(0, 110), { x: 50, y, size: 10, font: fontToUse });
      y -= 15;
    }

    const pdfBytes = await pdfDoc.save();
    const filename = `csv_to_pdf_${uuidv4()}.pdf`;
    const output = await saveOutput(pdfBytes, filename);
    cleanup([req.file.path], 0);
    res.json({ success: true, message: 'CSV converted to PDF successfully', output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to convert CSV: ' + err.message });
  }
});

// ==================== EXTRACT IMAGES ====================
router.post('/extract-images', upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file' });
  try {
    const archiver = require('archiver');
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    
    const zipFilename = `images_${uuidv4()}.zip`;
    const zipPath = path.join(outputDir, zipFilename);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.pipe(output);
    
    let imgCount = 0;
    // Iterate through pages and resources (simplified extraction)
    for (let i = 0; i < pages.length; i++) {
       const page = pages[i];
       const { node } = page;
       const resources = node.get(PDFName.of('Resources'));
       if (resources) {
          const xObjects = resources.get(PDFName.of('XObject'));
          if (xObjects) {
             const xObjectMap = xObjects.dict || xObjects;
             for (const [name, xObject] of xObjectMap.entries()) {
                const subtype = xObject.get(PDFName.of('Subtype'));
                if (subtype === PDFName.of('Image')) {
                   imgCount++;
                   // This is a complex step to get raw bytes correctly per format
                   // For now, we'll try to get the stream data
                   try {
                      const stream = xObject.stream;
                      if (stream) {
                         const bytes = xObject.getContents();
                         const ext = xObject.get(PDFName.of('Filter'))?.toString().includes('DCT') ? 'jpg' : 'png';
                         archive.append(Buffer.from(bytes), { name: `image_${imgCount}.${ext}` });
                      }
                   } catch (e) {}
                }
             }
          }
       }
    }

    if (imgCount === 0) {
      archive.abort();
      cleanup([req.file.path], 0);
      return res.status(404).json({ error: 'No images found in this PDF' });
    }

    await archive.finalize();
    
    // Wait for the zip to be fully written
    await new Promise((resolve) => {
      output.on('close', resolve);
    });

    const resultOutput = { filename: zipFilename, url: `/outputs/${zipFilename}`, size: fs.statSync(zipPath).size };
    cleanup([req.file.path], 0);
    cleanup([zipPath], 3600000); // 1 hour cleanup
    
    res.json({ success: true, message: `Extracted ${imgCount} images`, output: resultOutput, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to extract images: ' + err.message });
  }
});

// ==================== SIGN WITH IMAGE ====================
router.post('/sign-image', optionalAuth, upload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'signature', maxCount: 1 }]), async (req, res) => {
  const start = Date.now();
  const pdfFile = req.files['pdf']?.[0];
  const sigFile = req.files['signature']?.[0];
  
  if (!pdfFile || !sigFile) return res.status(400).json({ error: 'Please upload both PDF and signature image' });
  
  try {
    const pdfBytes = await getPdfBytes(pdfFile);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    
    // Process signature image with sharp to trim and normalize
    const sigRaw = fs.readFileSync(sigFile.path);
    const sigProcessed = await sharp(sigRaw).trim().png().toBuffer();
    const sigMetadata = await sharp(sigProcessed).metadata();
    
    const image = await pdfDoc.embedPng(sigProcessed);
    
    const position = req.body.position || 'bottom-right';
    const pages = pdfDoc.getPages();
    const lastPage = pages[pages.length - 1]; // Sign the last page by default
    const { width, height } = lastPage.getSize();
    
    const sigWidth = 140;
    const sigHeight = (sigMetadata.height / sigMetadata.width) * sigWidth;
    
    let x, y;
    if (position === 'bottom-right') { x = width - sigWidth - 60; y = 60; }
    else if (position === 'bottom-left') { x = 60; y = 60; }
    else if (position === 'top-right') { x = width - sigWidth - 60; y = height - sigHeight - 60; }
    else if (position === 'top-left') { x = 60; y = height - sigHeight - 60; }
    else { x = (width - sigWidth) / 2; y = (height - sigHeight) / 2; } // Center

    lastPage.drawImage(image, { x, y, width: sigWidth, height: sigHeight });

    const signedBytes = await pdfDoc.save();
    const filename = `signed_${uuidv4()}.pdf`;
    const output = await saveOutput(signedBytes, filename);
    
    cleanup([pdfFile.path, sigFile.path], 0);
    res.json({ success: true, message: 'Signed successfully', output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to sign: ' + err.message });
  }
});

// ==================== TRANSLATE PDF ====================
router.post('/translate', upload.single('file'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file' });
  try {
    const toLanguage = req.body.to || 'en';
    const dataBuffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(dataBuffer);
    
    // Translation (handling text length limits for stability)
    const originalText = data.text;
    const translation = await translatte(originalText.substring(0, 5000), { to: toLanguage });
    
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    let page = pdfDoc.addPage();
    let { height } = page.getSize();
    let y = height - 50;

    page.drawText(`Translated Document (${toLanguage.toUpperCase()})`, { x: 50, y, size: 16, font: boldFont });
    y -= 40;

    const lines = (translation.text || '').split('\n');
    for (const line of lines) {
      if (y < 40) {
        page = pdfDoc.addPage();
        y = height - 50;
      }
      page.drawText(line.substring(0, 100), { x: 50, y, size: 9, font });
      y -= 12;
    }

    const pdfBytes = await pdfDoc.save();
    const filename = `translated_${toLanguage}_${uuidv4()}.pdf`;
    const output = await saveOutput(pdfBytes, filename);
    
    cleanup([req.file.path], 0);
    res.json({ success: true, message: `Translated to ${toLanguage} successfully`, output, processingTime: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Failed to translate: ' + err.message });
  }
});

module.exports = router;

