"""Browser checks for the real measurement workflow. Run: python3 -m unittest discover -s tests -v"""
import functools
import http.server
import os
from pathlib import Path
import threading
import unittest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/'
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context()
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.goto(self.url)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def measure(self, kind, values):
        prefix = 't' if kind == 'target' else 'p'
        for k, v in zip(['L', 'a', 'b'], values):
            self.page.locator('#' + prefix + k).fill(str(v))
        self.page.get_by_role('button', name='＋ 측정값 추가').nth(0 if kind == 'target' else 1).click()

    def baseline(self):
        self.measure('target', (50, 20, -30))

    def test_statistics_recalculate_and_small_samples(self):
        for row in [(50.1,20.2,-30), (49.9,19.8,-30.2), (50,20,-29.8)]:
            self.measure('target', row)
        self.page.locator('#target-detail-button').click()
        self.assertEqual(self.page.locator('#target-detail-button').get_attribute('aria-expanded'), 'true')
        variance = self.page.locator('#target-detail tr').filter(has=self.page.get_by_role('rowheader', name='표본 분산', exact=True))
        self.assertEqual(variance.locator('td').all_text_contents(), ['0.0100','0.0400','0.0400'])
        self.page.on('dialog', lambda d: d.accept())
        for _ in range(2):
            self.page.locator('#target-table .del').first.click()
        self.assertEqual(variance.locator('td').all_text_contents(), ['—','—','—'])
        self.page.locator('#target-table .del').first.click()
        self.assertEqual(self.page.locator('#target-stats strong').all_text_contents(), ['—','—','—'])

    def test_measure_either_side_first_and_original_lab_delta(self):
        self.measure('print', (53,24,-30))
        self.assertEqual(self.page.locator('#de').inner_text(), '—')
        self.assertEqual(self.page.evaluate('state.print.length'), 1)
        self.baseline()
        self.assertEqual(self.page.locator('#de').inner_text(), '5.00')
        self.assertIn('불합격', self.page.locator('#verdict').inner_text())
        self.page.locator('#threshold').fill('5')
        self.page.locator('#threshold').dispatch_event('change')
        self.assertIn('합격', self.page.locator('#verdict').inner_text())

    def test_target_average_updates_immediately(self):
        self.baseline()
        self.measure('print', (55,20,-30))
        self.assertEqual(self.page.locator('#de').inner_text(), '5.00')
        self.measure('target', (60,20,-30))
        self.assertEqual(self.page.locator('#de').inner_text(), '0.00')
        self.page.on('dialog', lambda d: d.accept())
        self.page.locator('#target-table .del').last.click()
        self.assertEqual(self.page.locator('#de').inner_text(), '5.00')
        self.assertEqual(self.page.get_by_role('button', name='타겟 기준 확정', exact=True).count(), 0)

    def test_measurement_storage_and_clear_only_one_side(self):
        self.baseline()
        self.measure('print', (51.2,19.2,-29.6))
        self.page.locator('#meta-job').fill('새 작업 & 보고서')
        self.page.reload()
        self.assertEqual(self.page.locator('#de').inner_text(), '1.50')
        self.assertEqual(self.page.locator('#meta-job').input_value(), '새 작업 & 보고서')
        self.page.on('dialog', lambda d: d.accept())
        self.page.get_by_role('button', name='측정값 비우기', exact=True).last.click()
        self.assertEqual(self.page.evaluate('state.target.length'), 1)
        self.assertEqual(self.page.evaluate('state.print.length'), 0)
        self.assertEqual(self.page.locator('#de').inner_text(), '—')
        self.measure('print', (50,20,-30))
        self.assertEqual(self.page.locator('#de').inner_text(), '0.00')

    def test_gamut_warning_preserves_large_delta(self):
        self.measure('target', (50,100,100))
        self.measure('print', (50,110,110))
        self.assertEqual(self.page.locator('#de').inner_text(), '14.14')
        self.assertIn('안내 보류', self.page.locator('#guide-copy').inner_text())
        self.assertEqual(self.page.locator('#channels').inner_text().count('안내 보류'), 4)

    def test_export_import_validation_and_safe_text(self):
        self.baseline()
        self.measure('print', (50,20,-30))
        self.page.locator('#meta-job').fill('<img src=x onerror=alert(1)>')
        self.assertEqual(self.page.locator('#print-job img').count(), 0)
        with self.page.expect_download() as event:
            self.page.get_by_role('button', name='JSON 저장', exact=True).click()
        import json
        data = Path(event.value.path()).read_bytes()
        self.assertEqual(json.loads(data)['schemaVersion'], 2)
        self.page.on('dialog', lambda d: d.accept())
        self.page.get_by_role('button', name='새 작업', exact=True).click()
        self.page.locator('#import-file').set_input_files({'name':'backup.json','mimeType':'application/json','buffer':data})
        self.page.wait_for_function('state.target.length === 1')
        self.assertEqual(self.page.locator('#de').inner_text(), '0.00')
        self.page.locator('#import-file').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{"schemaVersion":1}'})
        self.page.wait_for_function("document.getElementById('toast').textContent.includes('실패')")
        self.assertEqual(self.page.locator('#de').inner_text(), '0.00')

    def test_print_report_has_both_measurements_without_history(self):
        self.baseline()
        self.measure('print', (53,24,-30))
        self.page.evaluate('buildReport()')
        self.page.emulate_media(media='print')
        self.assertTrue(self.page.locator('#target-detail').is_visible())
        self.assertEqual(self.page.locator('#report-archive .report-block').count(), 1)
        self.assertIn('타겟 원본 측정 기록', self.page.locator('#report-archive').inner_text())
        self.assertIn('인쇄물 원본 측정 기록', self.page.locator('#report-archive').inner_text())
        self.assertNotIn('교정 이력', self.page.locator('body').inner_text())
        self.assertGreater(len(self.page.pdf(format='A4', print_background=True)), 1000)
        self.page.emulate_media(media='screen')
        self.page.set_viewport_size({'width':390,'height':844})
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))

    def test_corrupt_storage_is_not_overwritten(self):
        self.page.evaluate("localStorage.setItem(STORAGE_KEY,'broken data')")
        self.page.reload()
        self.assertIn('확인 필요', self.page.locator('#save-status').inner_text())
        self.measure('target', (50,20,-30))
        self.assertEqual(self.page.evaluate('localStorage.getItem(STORAGE_KEY)'), 'broken data')

    def test_correct_bad_measurement_by_delete_and_add(self):
        self.baseline()
        self.measure('print', (60,20,-30))
        self.assertEqual(self.page.locator('.edit-row').count(), 0)
        self.page.on('dialog', lambda d:d.accept())
        self.page.locator('#print-table .del').first.click()
        self.measure('print', (50,20,-30))
        self.assertEqual(self.page.locator('#de').inner_text(), '0.00')

    def test_legacy_storage_migrates_and_keeps_original_history(self):
        import json
        row = {'id':'target-1','L':50,'a':20,'b':-30,'position':'중앙','time':'2026-10-13T00:00:00Z'}
        legacy = {
            'schemaVersion':1,'id':'legacy-project',
            'metadata':{k:'' for k in ['job','sample','paper','press','device','mode','light','method']},
            'target':[row], 'baselines':[{'id':'b1','version':1,'rows':[row],'createdAt':row['time']}],
            'activeBaselineId':'b1',
            'stages':[
                {'id':'s1','name':'초기 측정','baselineId':'b1','threshold':2,'rows':[dict(row,id='p1',L=60)],'note':'조정 전','createdAt':row['time']},
                {'id':'s2','name':'1차 교정','baselineId':'b1','threshold':3,'rows':[dict(row,id='p2',L=51)],'note':'교정','createdAt':row['time']}
            ],'selectedStageId':'s2','updatedAt':row['time']
        }
        serialized=json.dumps(legacy,ensure_ascii=False)
        self.page.evaluate("text => {localStorage.removeItem(STORAGE_KEY);localStorage.setItem(LEGACY_STORAGE_KEY,text)}",serialized)
        self.page.reload()
        self.assertEqual(self.page.locator('#de').inner_text(), '1.00')
        self.assertEqual(self.page.locator('#threshold').input_value(), '3')
        self.assertEqual(self.page.evaluate('localStorage.getItem(LEGACY_STORAGE_KEY)'),serialized)
        self.assertEqual(self.page.evaluate('state.legacyArchive.stages.length'),2)
        self.page.reload()
        self.assertEqual(self.page.locator('#de').inner_text(), '1.00')
        self.assertEqual(self.page.evaluate('state.legacyArchive.stages.length'),2)

if __name__ == '__main__':
    unittest.main()
