export default async function run(page, ui) {
  await page.waitForFunction(() => document.documentElement.dataset.fpvLab === 'ready');
  await page.waitForTimeout(900);
  return await page.evaluate(() => {
    const d = document.documentElement.dataset;
    return JSON.stringify({
      flag: d.fpvDebugFlag,
      diagErr: d.fpvDiagError || null,
      frameErr: d.fpvError || null,
      dbg: (d.fpvDebug || '').slice(0, 400),
    });
  });
}
