import { destr } from 'destr'
import { z } from 'zod'

defineRouteMeta({
  openAPI: {
    description: 'Generate a slug using AI based on the URL',
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: 'url',
        in: 'query',
        required: true,
        schema: { type: 'string', format: 'uri' },
        description: 'The URL to generate a slug for',
      },
    ],
  },
})

interface AiChatResponse {
  response?: string
  choices?: { message?: { content?: string } }[]
}

export default eventHandler(async (event) => {
  const url = (await getValidatedQuery(event, z.object({
    url: z.string().url(),
  }).parse)).url
  const { cloudflare } = event.context
  const { AI } = cloudflare.env

  if (!AI) {
    throw createError({ status: 501, statusText: 'AI not enabled' })
  }

  const { aiPrompt, aiModel } = useRuntimeConfig(event)
  const { slugRegex } = useAppConfig()

  const markdown = await fetchPageMarkdown(event, url, AI)
  const userContent = markdown
    ? `URL: ${url}\n\nPage content:\n${markdown}`
    : url

  const messages = [
    { role: 'system', content: aiPrompt.replace('{slugRegex}', slugRegex.toString()) },

    { role: 'user', content: 'https://www.cloudflare.com/' },
    { role: 'assistant', content: '{"slug": "cloudflare"}' },

    { role: 'user', content: 'https://github.com/nuxt/' },
    { role: 'assistant', content: '{"slug": "nuxt"}' },

    { role: 'user', content: 'https://sink.cool/' },
    { role: 'assistant', content: '{"slug": "sink-cool"}' },

    { role: 'user', content: 'https://github.com/miantiao-me/sink' },
    { role: 'assistant', content: '{"slug": "sink"}' },

    { role: 'user', content: userContent },
  ]

  const response = await AI.run(aiModel as keyof AiModels, {
    messages,
  }) as AiChatResponse

  let content = response.response ?? response.choices?.[0]?.message?.content ?? ''

  if (!content || content.trim() === '') {
    console.error('AI.run() returned an empty response. Full response object:', JSON.stringify(response))
    // Fallback: try to generate a simple slug from the URL domain/path
    try {
      const urlObj = new URL(url)
      const pathSegments = urlObj.pathname.split('/').filter(Boolean)
      const domain = urlObj.hostname.split('.').filter(p => !['www', 'com', 'org', 'net', 'io'].includes(p))[0] || urlObj.hostname.split('.')[0]
      const fallbackSlug = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : domain

      if (fallbackSlug) {
        return {
          slug: fallbackSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 50),
        }
      }
    }
    catch (e) {
      console.error('Fallback slug generation failed:', e)
    }

    throw createError({
      statusCode: 500,
      statusMessage: 'AI returned an empty response and fallback failed',
    })
  }

  // 1. Try to strip markdown code block wrapper (e.g. ```json\n{...}\n```)
  const codeBlockMatch = content.match(/```(?:json)?\n([\s\S]*?)```/)
  if (codeBlockMatch?.[1]) {
    content = codeBlockMatch[1].trim()
  }
  else {
    // 2. Try balanced brace extraction to handle trailing conversational text
    const firstBrace = content.indexOf('{')
    if (firstBrace !== -1) {
      let depth = 0
      for (let i = firstBrace; i < content.length; i++) {
        if (content[i] === '{') {
          depth++
        }
        else if (content[i] === '}') {
          depth--
          if (depth === 0) {
            content = content.substring(firstBrace, i + 1)
            break
          }
        }
      }
    }
  }

  let parsed = destr(content)

  // Ensure we always return an object with a slug property
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // Try regex fallback if destr fails to produce an object
    const slugMatch = content.match(/"slug"\s*:\s*"([^"]+)"/)
    if (slugMatch && slugMatch[1]) {
      parsed = { slug: slugMatch[1] }
    }
    else {
      // Last resort fallback: try to find anything that looks like a slug in the string
      // Look for an explicit "slug: <value>" first
      const explicitMatch = content.match(/slug[:\s]+([a-z0-9-]+)/i)
      if (explicitMatch && explicitMatch[1]) {
        parsed = { slug: explicitMatch[1].toLowerCase() }
      }
      else {
        // Try to find the most "slug-like" word in the content
        // Slugs are usually hyphenated or longer alphanumeric strings
        const words = content.match(/[a-z0-9-]+/gi) || []
        // Filter out common short words
        const candidates = words.filter(w => w.length > 2 && !['the', 'this', 'that', 'your', 'with', 'here', 'your', 'slug'].includes(w.toLowerCase()))

        // Prioritize hyphenated words as they are likely intended as slugs
        const bestCandidate = candidates.find(w => w.includes('-')) || candidates[0] || words[0]

        if (bestCandidate) {
          parsed = { slug: bestCandidate.toLowerCase() }
        }
        else {
          console.error('AI response parsing failed. Final content:', content)
          throw createError({
            statusCode: 500,
            statusMessage: 'Invalid AI response format',
          })
        }
      }
    }
  }

  // Final validation of the parsed object
  const result = parsed as Record<string, any>
  if (typeof result !== 'object' || !result.slug) {
    throw createError({
      statusCode: 500,
      statusMessage: 'AI response missing slug property',
    })
  }

  return {
    slug: String(result.slug),
  }
})
