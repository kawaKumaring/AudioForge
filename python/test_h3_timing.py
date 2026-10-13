import unittest
from h3_timing import estimate,split_by_budget,MAX_FRAMES

class Timing(unittest.TestCase):
    def test_normal_short_and_long_budgets(self):
        self.assertEqual(estimate('가'*54)['frames'],243)
        self.assertEqual(estimate('가'*172)['frames'],736)
        self.assertEqual(split_by_budget(('가'*86+' ')*2),[('가'*86+' ')*2])
    def test_spaces_and_punctuation_do_not_inflate_budget(self):
        self.assertEqual(estimate('안녕하세요')['frames'],estimate('  안 녕 하 세 요 !!!  ')['frames'])
    def test_numeric_and_foreign_have_nonzero_units_and_uncertainty(self):
        for text in ['안녕 1234','안녕 QWEN','안녕 Ω']:
            self.assertGreater(estimate(text)['units'],2)
            self.assertTrue(estimate(text)['uncertainty'])
    def test_ordinal_estimate_does_not_rewrite_input(self):
        text='7번째 장면입니다.'
        self.assertEqual(estimate(text)['units'],estimate('일곱 번째 장면입니다.')['units'])
        self.assertEqual(''.join(split_by_budget(text)),text)
    def test_sentence_boundary_preferred_and_all_text_preserved(self):
        text='가'*80+'. '+'나'*80+' '+ '다'*30
        chunks=split_by_budget(text)
        self.assertTrue(chunks[0].rstrip().endswith('.'))
        self.assertEqual(''.join(chunks),text)
        self.assertTrue(all(estimate(c)['frames']<=MAX_FRAMES for c in chunks))
    def test_long_word_rejected_instead_of_cut(self):
        with self.assertRaises(RuntimeError):split_by_budget('가'*200)
    def test_no_readable_text_rejected(self):
        with self.assertRaises(ValueError):estimate(' !!! ')
    def test_no_extra_pause_for_each_punctuation(self):
        a=estimate('가'*54);b=estimate('가'*27+'. '+'가'*27+'.')
        self.assertEqual(a['frames'],b['frames'])
    def test_original_line_breaks_preserved(self):
        text=('같은 대사입니다.\n'*30)
        self.assertEqual(''.join(split_by_budget(text)),text)

if __name__=='__main__':unittest.main()
