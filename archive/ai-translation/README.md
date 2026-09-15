# Archived: AI Translation Plugin for HydroOJ

> [!WARNING]
> This module is retired, no longer used, and no longer maintained. It is kept
> only for historical reference and must not be enabled in production.

AI-powered problem description translation with image OCR support.

## Features

- **AI Translation**: Automatically translate problem descriptions using OpenAI-compatible APIs
- **Image OCR**: Extract text from images in problem descriptions using vision models
- **Multi-language Support**: Stores translations as `problem_ai` in the content field
- **Manual Trigger**: Translation button on problem detail page
- **Cache Support**: Avoids redundant translations within configured cache time

## Historical Installation (Do Not Use)

Historically, this package was copied to `Hydro/packages/ai-translation/`, its
dependencies were installed, and the plugin was configured in HydroOJ.

## Historical Configuration

The retired module used the following HydroOJ configuration:

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

## Historical Usage

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

## How It Worked

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

## Historical Development Notes

### File Structure

```
archive/ai-translation/
├── index.ts              # Plugin entry point
├── handler/translation.ts # API handlers
├── service/translation.ts # AI translation service
├── templates/            # UI templates
├── locales/              # I18n files
└── package.json
```

## License

AGPL-3.0-or-later
