import { NextResponse } from 'next/server';
import { createVisit } from '../../../lib/database/visits';
import { updatePlaceAfterVisit } from '../../../lib/database/places';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { 
      placeId, 
      companions, 
      conversationSummary, 
      mood, 
      isDetour, 
      notableEvent 
    } = body;

    // 1. Visit を作る（会話の要約や気分を保存）
    const visitId = await createVisit(
      placeId,
      companions,
      conversationSummary,
      mood,
      isDetour,
      notableEvent
    );

    // 2. Place の訪問回数と最終訪問日時を更新する
    await updatePlaceAfterVisit(placeId);

    return NextResponse.json({ success: true, visitId }, { status: 201 });
  } catch (error) {
      console.error(error);
    return NextResponse.json({ error: '訪問記録の作成に失敗しました' }, { status: 500 });
  }
}