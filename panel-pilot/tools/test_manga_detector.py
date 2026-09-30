import unittest

from manga_detector_report import consolidate_manga_panels


class MangaConsolidationTests(unittest.TestCase):
    def test_kingdom_page_18_shifted_bands_become_three_continuous_regions(self):
        panels = [
            {"x": .61526, "y": .04333, "w": .36688, "h": .21889},
            {"x": .61526, "y": .17889, "w": .36688, "h": .17667},
            {"x": 0, "y": .04333, "w": .63799, "h": .21889},
            {"x": 0, "y": .17889, "w": .63636, "h": .17667},
            {"x": .60877, "y": .28667, "w": .37338, "h": .20889},
            {"x": 0, "y": .28667, "w": .64123, "h": .20889},
            {"x": 0, "y": .47778, "w": .99188, "h": .17333},
            {"x": 0, "y": .45889, "w": .99188, "h": .54778},
        ]
        self.assertEqual(len(consolidate_manga_panels(panels)), 3)

    def test_kingdom_page_19_shifted_bands_become_three_continuous_regions(self):
        panels = [
            {"x": .19967, "y": 0, "w": .74092, "h": .19778},
            {"x": .19967, "y": .04556, "w": .74257, "h": .19778},
            {"x": .02475, "y": 0, "w": .19802, "h": .19778},
            {"x": .02475, "y": .04556, "w": .19802, "h": .19667},
            {"x": .02475, "y": .24222, "w": .91749, "h": .05889},
            {"x": .02475, "y": .24222, "w": .91749, "h": .29889},
            {"x": .02475, "y": .35, "w": .91749, "h": .29889},
            {"x": .0231, "y": .47444, "w": .92079, "h": .49111},
        ]
        self.assertEqual(len(consolidate_manga_panels(panels)), 3)

    def test_adjacent_panels_do_not_merge(self):
        panels = [
            {"x": .05, "y": .05, "w": .42, "h": .3},
            {"x": .53, "y": .05, "w": .42, "h": .3},
            {"x": .05, "y": .40, "w": .90, "h": .5},
        ]
        self.assertEqual(len(consolidate_manga_panels(panels)), 3)


if __name__ == "__main__":
    unittest.main()
