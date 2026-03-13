import type { PoiCategory } from '../../shared/types'

interface CategoryRule {
  category: PoiCategory
  azureQuery: string
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: 'hospitals',
    azureQuery: 'hospital',
  },
  {
    category: 'schools',
    azureQuery: 'school',
  },
  {
    category: 'malls',
    azureQuery: 'shopping mall',
  },
  {
    category: 'restaurants',
    azureQuery: 'restaurant',
  },
  {
    category: 'coffee_shops',
    azureQuery: 'coffee shop',
  },
  {
    category: 'movie_theaters',
    azureQuery: 'movie theater',
  },
]

export function getAzureCategoryQuery(category: PoiCategory): string {
  return CATEGORY_RULES.find(candidate => candidate.category === category)?.azureQuery ?? category.replaceAll('_', ' ')
}
