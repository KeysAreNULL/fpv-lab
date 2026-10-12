export default async function run(page, ui) {
  const read = () => page.evaluate(() => JSON.parse(document.documentElement.dataset.fpvDebug || '{}'));
  await page.waitForFunction(() => document.documentElement.dataset.fpvLab === 'ready');
  await page.getByRole('button', { name: 'Simulator' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Arm', exact: true }).click();
  await page.waitForTimeout(200);
  await page.keyboard.down('Space');
  const snaps = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(300);
    const d = await read();
    snaps.push({ t: i, alt: d.alt, io: d.io, cur: d.current, rpm0: (d.rpm || [])[0] });
  }
  await page.keyboard.up('Space');
  return { snaps };
}
