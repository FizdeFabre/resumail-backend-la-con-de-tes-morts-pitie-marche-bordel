// routes/reports.js

import express from 'express';
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { supabase } from '../supabaseClient.js';

const router = express.Router();

router.get('/:id/pdf', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).send('Missing report id');

    // 🧩 Charger le rapport principal
    const { data: report, error: rptErr } = await supabase
      .from('reports')
      .select('*')
      .eq('id', id)
      .single();

    if (rptErr || !report)
      return res.status(404).json({ error: 'Report not found' });

    // 🧩 Charger les mini-rapports liés
    let miniReports = [];
    let miniIds = [];
    try {
      if (Array.isArray(report.mini_report_ids)) miniIds = report.mini_report_ids;
      else if (typeof report.mini_report_ids === 'string')
        miniIds = JSON.parse(report.mini_report_ids || '[]');
    } catch {}

    if (miniIds.length) {
      const { data: minis } = await supabase
        .from('reports')
        .select('*')
        .in('id', miniIds);
      miniReports = minis || [];
    }

    // 🧾 Création du PDF
    const doc = new PDFDocument({
      size: 'A4',
      margin: 60,
      bufferPages: true,
      info: {
        Title: `Rapport Resumail`,
        Author: 'Resumail',
        Subject: 'Analyse de courriels',
      },
    });

    // 📄 Configuration sortie PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="resumail-report-${id}.pdf"`);
    doc.pipe(res);

    // 🖋️ Charger la police (fallback Helvetica)
    const fontPath = path.join(process.cwd(), 'public', 'fonts', 'DejaVuSans.ttf');
    if (fs.existsSync(fontPath)) {
      doc.registerFont('DejaVu', fontPath);
      doc.font('DejaVu');
    } else {
      console.warn('⚠️ Police DejaVuSans non trouvée, utilisation de Helvetica.');
      doc.font('Helvetica');
    }

        const fontPathBold = path.join(process.cwd(), 'public', 'fonts', 'DejaVuSans-Bold.ttf');
    if (fs.existsSync(fontPathBold)) {
      doc.registerFont('DejaVu-Bold', fontPathBold);
      doc.font('DejaVu-Bold');
    } else {
      console.warn('⚠️ Police DejaVuSans-Bold non trouvée, utilisation de Helvetica.');
      doc.font('Helvetica');
    }

    const colors = {
      primary: '#1E3A8A',
      text: '#1F2937',
      gray: '#6B7280',
      light: '#F3F4F6',
    };

    // 🧱 Helper pour titres de section
    const sectionTitle = (title) => {
      const y = doc.y;
      doc.save();
      doc.rect(60, y, 475, 25).fill(colors.primary);
      doc.fillColor('#fff').font('DejaVu').fontSize(14).text(title, 70, y + 6);
      doc.restore();
      doc.moveDown(1.5);
    };

    // 🏁 Page de garde
    const userName = report.user_id ?? 'Utilisateur inconnu';
    const dateStr = new Date(report.created_at).toLocaleString();

    doc.fontSize(26).fillColor(colors.primary)
      .text('Rapport d’Analyse – Resumail', { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(14).fillColor(colors.gray)
      .text(userName, { align: 'center' });
    doc.text(dateStr, { align: 'center' });

    doc.addPage();

    // 🧩 RÉSUMÉ GÉNÉRAL
    sectionTitle('Résumé Général');
    const summary = report.report_text ?? 'Aucun résumé disponible.';
    doc.font('DejaVu').fillColor(colors.text).fontSize(12)
      .text(summary, { align: 'justify', lineGap: 5 });
    doc.moveDown(2);

    // 📊 STATISTIQUES GLOBALES
    sectionTitle('Statistiques et Sentiments');

    const stats = report.classification || {};
    const data = {
      positive: stats.positive || 0,
      neutral: stats.neutral || 0,
      negative: stats.negative || 0,
      other: stats.other || 0,
    };

    const total = Object.values(data).reduce((a, b) => a + b, 0) || 1;
    const centerX = doc.page.width / 2;
    const centerY = doc.y + 100;
    const radius = 70;

    let startAngle = 0;
    const colorsChart = {
      positive: '#10B981',
      neutral: '#F59E0B',
      negative: '#EF4444',
      other: '#9CA3AF',
    };

    for (const [key, val] of Object.entries(data)) {
      const angle = (val / total) * Math.PI * 2;
      doc.save();
      doc.moveTo(centerX, centerY);
      doc.fillColor(colorsChart[key]);
      doc.arc(centerX, centerY, radius, startAngle, startAngle + angle);
      doc.lineTo(centerX, centerY).fill();
      doc.restore();
      startAngle += angle;
    }

    // 🧾 Légende du camembert
    doc.moveDown(8);
    doc.fontSize(11);
    for (const [key, val] of Object.entries(data)) {
      doc.fillColor(colorsChart[key])
        .rect(100, doc.y, 10, 10).fill();
      doc.fillColor(colors.text)
        .text(`  ${key}: ${val}`, 120, doc.y - 1);
      doc.moveDown(0.5);
    }

    doc.moveDown(2);

    // 💬 HIGHLIGHTS
    sectionTitle('Highlights');

    const highlights = report.highlights || [];
    const selected = highlights.sort(() => 0.5 - Math.random()).slice(0, 4);

    if (selected.length > 0) {
      selected.forEach((txt) => {
        const t = typeof txt === 'string' ? txt : txt.text || JSON.stringify(txt);
        doc.font('DejaVu').fillColor(colors.text).fontSize(11)
          .text(`• ${t}`, { paragraphGap: 6, lineGap: 3 });
      });
    } else {
      doc.font('DejaVu').fillColor(colors.gray).fontSize(11)
        .text('Aucun retour significatif disponible.');
    }

    doc.moveDown(2);

    // 📂 MINI-RAPPORTS
    if (miniReports.length) {
      doc.addPage();
      sectionTitle('Mini-rapports détaillés');

      miniReports.forEach((m, i) => {
        const sub = m.report_text ?? m.summary ?? 'Aucun résumé disponible.';
        doc.font('DejaVu-Bold').fillColor(colors.primary)
          .fontSize(13)
          .text(`Sous-rapport #${i + 1} (${m.total_emails || 0} emails)`);
        doc.font('DejaVu').fillColor(colors.text)
          .fontSize(11)
          .text(sub, { paragraphGap: 8, align: 'justify', lineGap: 3 });
        doc.moveDown(1);
      });
    }

    // 📄 Pied de page + pagination
    const range = doc.bufferedPageRange();
    const genDate = new Date().toLocaleString();

    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(9).fillColor(colors.gray)
        .text(`Resumail • ${genDate} • Page ${i + 1}/${range.count}`,
          50, doc.page.height - 50, { align: 'center' });
    }

    // ✅ Nettoyage & envoi
    doc.flushPages(); // avant doc.end()
    doc.end();

  } catch (err) {
    console.error('/reports/:id/pdf error', err);
    return res.status(500).json({ error: 'Failed to render PDF', detail: err.message });
  }
});

export default router;