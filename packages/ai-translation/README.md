# AI Translation Plugin for HydroOJ

AI-powered problem description translation with image OCR support.

## Features

- **AI Translation**: Automatically translate problem descriptions using OpenAI-compatible APIs
- **Image OCR**: Extract text from images in problem descriptions using vision models
- **Multi-language Support**: Stores translations as `problem_ai` in the content field
- **Manual Trigger**: Translation button on problem detail page
- **Cache Support**: Avoids redundant translations within configured cache time

## Installation

1. Copy this package to `Hydro/packages/ai-translation/`
2. Install dependencies: `yarn install`
3. Configure the plugin in HydroOJ system settings

## Configuration

Add to your HydroOJ configuration:

```yaml
ai_translation:
  enabled: true
  apiEndpoint: https://api.openai.com/v1  # Or any OpenAI-compatible endpoint
  apiKey: ${env.OPENAI_API_KEY}           # Set via environment variable
  model: gpt-4o-mini                       # Model with vision support
  maxTokens: 4000
  temperature: 0.3
  cacheHours: 24
```

## Usage

### Manual Translation

1. Navigate to any problem detail page
2. Click the "AI Translate" button in the translation panel
3. Wait for translation to complete
4. View the translated content by clicking "View"

### API Endpoints

- `POST /api/translation/translate` - Trigger translation for a problem
  - Params: `pid` (problem ID), `force` (optional, force re-translation)
  
- `GET /api/translation/status` - Check translation status
  - Params: `pid` (problem ID)

## How It Works

1. **Content Parsing**: Extracts problem content from the `content` field (JSON format with language keys)
2. **Image Processing**: Identifies images in the description and sends them to the AI model for OCR
3. **Translation**: Sends content + images to OpenAI-compatible API with optimized prompts
4. **Storage**: Saves translated content as `content.ai` in the problem document
5. **Display**: Translation panel appears on problem detail page when AI translation exists

## Image Handling

The plugin handles images in problem descriptions:

- **Supported formats**: PNG, JPG, JPEG, GIF, WebP, BMP
- **OCR**: Vision-capable models extract text from images
- **Description**: Non-text images are described and referenced
- **File paths**: Automatically resolves `file://` references to actual files

## Supported Models

Any OpenAI-compatible API endpoint with vision support:

- OpenAI GPT-4o, GPT-4o-mini, GPT-4 Vision
- Claude 3 (via OpenAI-compatible proxy)
- Gemini (via OpenAI-compatible proxy)
- Local models with vision capabilities (via vLLM, etc.)

## Development

### File Structure

```
packages/ai-translation/
├── index.ts              # Plugin entry point
├── handler/translation.ts # API handlers
├── service/translation.ts # AI translation service
├── templates/            # UI templates
├── locales/              # I18n files
└── package.json
```

### Adding New Features

1. **New AI Provider**: Extend `TranslationService` in `service/translation.ts`
2. **UI Changes**: Modify `templates/translation_panel.html`
3. **API Changes**: Add routes in `index.ts` and handlers in `handler/translation.ts`

## License

AGPL-3.0-or-later
